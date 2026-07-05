import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { APIError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import { getProviderEnvGuard } from './provider-config';
import { convertZodSchema, ensureSchemaName } from './schema-utils';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const PROVIDER_NAME = 'bedrock';
const DEFAULT_MODEL = 'anthropic.claude-sonnet-5';
// Sonnet output ceiling; the chat route requests 65536 which would 400 unclamped.
const MAX_OUTPUT_TOKENS = 64000;
const DEFAULT_OUTPUT_TOKENS = 16000;

// The chat route requests 65536 on every call, so a per-request warn would
// spam production logs — warn once per process.
let clampWarned = false;

function resolveMaxTokens(requested?: number): number {
  if (typeof requested !== 'number' || requested <= 0) {
    return DEFAULT_OUTPUT_TOKENS;
  }
  if (requested > MAX_OUTPUT_TOKENS) {
    if (!clampWarned) {
      clampWarned = true;
      // The cap is Sonnet's ceiling, not a per-model lookup — surface the
      // clamp so operators on higher-output models can spot it.
      console.warn(
        `[Bedrock] maxOutputTokens ${requested} exceeds the ${MAX_OUTPUT_TOKENS} cap; clamping (warned once per process).`
      );
    }
    return MAX_OUTPUT_TOKENS;
  }
  return requested;
}

// The Bedrock Mantle endpoint rejects output_config.format and strict tools
// ("Extra inputs are not permitted"), so structured output rides on a forced
// tool call whose input_schema is the converted Zod schema. The tool input is
// re-validated with Zod before returning.
//
// Tool input_schema must be type "object"; non-object schemas (the app's
// topicGenerationSchema is a top-level z.array) are wrapped in {result: ...}
// and unwrapped on extraction.
const WRAPPER_KEY = 'result';

function buildStructuredTool(params: ProviderGenerateParams): {
  tool: Tool;
  wrapped: boolean;
} {
  if (!params.zodSchema) {
    throw new Error('buildStructuredTool requires a zodSchema.');
  }

  const jsonSchema = convertZodSchema(params.zodSchema);

  const wrapped = jsonSchema.type !== 'object';
  const inputSchema = wrapped
    ? {
        type: 'object',
        properties: { [WRAPPER_KEY]: jsonSchema },
        required: [WRAPPER_KEY],
      }
    : jsonSchema;

  return {
    tool: {
      name: 'emit_result',
      description: `Return the ${ensureSchemaName(params.schemaName)} result.`,
      input_schema: inputSchema as Tool['input_schema'],
    },
    wrapped,
  };
}

function extractToolInput(message: Message, wrapped: boolean): unknown {
  const toolUse = message.content.find(
    (block): block is Extract<typeof block, { type: 'tool_use' }> =>
      block.type === 'tool_use'
  );
  const input = toolUse?.input;

  if (wrapped && input != null && typeof input === 'object') {
    return (input as Record<string, unknown>)[WRAPPER_KEY];
  }

  return input;
}

function extractText(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

function normalizeUsage(message: Message, latencyMs: number) {
  const promptTokens = message.usage?.input_tokens;
  const completionTokens = message.usage?.output_tokens;
  const totalTokens =
    typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? promptTokens + completionTokens
      : undefined;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs,
  };
}

function buildBaseRequest(params: ProviderGenerateParams): MessageCreateParamsNonStreaming {
  const request: MessageCreateParamsNonStreaming = {
    model: params.model ?? DEFAULT_MODEL,
    max_tokens: resolveMaxTokens(params.maxOutputTokens),
    messages: [
      {
        role: 'user',
        content: params.prompt,
      },
    ],
  };

  // Sampling parameters are intentionally not forwarded: current Claude
  // models on Bedrock reject them ("`temperature` is deprecated for this
  // model" — verified live on anthropic.claude-sonnet-5). Callers' hints
  // are silently dropped, matching how newer Claude APIs removed sampling.

  return request;
}

// Message phrasing is load-bearing: the registry's isRetryableError matches
// on substrings ("rate limit", "service unavailable", "overload", "timeout",
// and status codes) to decide whether to try a fallback provider. The
// original SDK error (request-id, headers, stack) rides along as `cause`.
function normalizeBedrockError(error: unknown): Error {
  const cause = { cause: error };

  if (error instanceof APIConnectionTimeoutError) {
    return new Error('Bedrock API timeout: request timed out.', cause);
  }

  if (error instanceof APIError) {
    const status = error.status;
    const detail = error.message;

    if (status === 429) {
      return new Error(`Bedrock API rate limit: ${detail}`, cause);
    }
    if (status === 401 || status === 403) {
      return new Error(`Bedrock API authentication failed: ${detail}`, cause);
    }
    if (status === 408) {
      return new Error(`Bedrock API timeout: ${detail}`, cause);
    }
    if (typeof status === 'number' && status >= 500) {
      return new Error(`Bedrock API service unavailable (${status}): ${detail}`, cause);
    }
    return new Error(`Bedrock API error${status ? ` (${status})` : ''}: ${detail}`, cause);
  }

  return error instanceof Error ? error : new Error(String(error), cause);
}

export function createBedrockAdapter(): ProviderAdapter {
  // Same source of truth as provider discovery — the guard IS the region.
  const awsRegion = getProviderEnvGuard('bedrock')();
  if (!awsRegion) {
    throw new Error(
      'AWS_REGION (or AWS_BEDROCK_REGION) is required to use the Bedrock provider. Set the environment variable and try again.'
    );
  }

  const client = new AnthropicBedrockMantle({ awsRegion });

  return {
    name: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
      const requestStartedAt = Date.now();
      const requestOptions =
        params.timeoutMs && params.timeoutMs > 0
          ? { timeout: params.timeoutMs }
          : undefined;

      const baseRequest = buildBaseRequest(params);
      let message: Message;
      let content: string;

      // Streaming keeps long generations from hitting HTTP timeouts; the
      // adapter still resolves to a single complete result.
      try {
        if (params.zodSchema) {
          const { tool, wrapped } = buildStructuredTool(params);
          message = await client.messages
            .stream(
              {
                ...baseRequest,
                tools: [tool],
                tool_choice: { type: 'tool', name: tool.name },
              },
              requestOptions
            )
            .finalMessage();

          const toolInput = extractToolInput(message, wrapped);
          if (toolInput == null) {
            throw new Error('Bedrock API returned an empty structured response.');
          }
          const parsed = params.zodSchema.safeParse(toolInput);
          if (!parsed.success) {
            throw new Error(
              `Bedrock structured output validation failed: ${parsed.error.message}`
            );
          }
          content = JSON.stringify(parsed.data);
        } else {
          message = await client.messages
            .stream(baseRequest, requestOptions)
            .finalMessage();
          content = extractText(message);
        }
      } catch (error) {
        throw normalizeBedrockError(error);
      }

      if (!content) {
        throw new Error('Bedrock API returned an empty response.');
      }

      return {
        content,
        rawResponse: message,
        provider: PROVIDER_NAME,
        model: message.model ?? String(baseRequest.model),
        usage: normalizeUsage(message, Date.now() - requestStartedAt),
      };
    },
  };
}
