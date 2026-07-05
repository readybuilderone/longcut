import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import type { ProviderAdapter, ProviderGenerateParams, ProviderGenerateResult } from './types';

const PROVIDER_NAME = 'bedrock';
const DEFAULT_MODEL = 'anthropic.claude-sonnet-4-6';
// Sonnet output ceiling; the chat route requests 65536 which would 400 unclamped.
const MAX_OUTPUT_TOKENS = 64000;
const DEFAULT_OUTPUT_TOKENS = 16000;

function resolveRegion(): string | undefined {
  return process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION;
}

function resolveMaxTokens(requested?: number): number {
  if (typeof requested !== 'number' || requested <= 0) {
    return DEFAULT_OUTPUT_TOKENS;
  }
  return Math.min(requested, MAX_OUTPUT_TOKENS);
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

  // Claude 4+ rejects temperature and top_p together — send at most one.
  if (typeof params.temperature === 'number') {
    request.temperature = params.temperature;
  } else if (typeof params.topP === 'number') {
    request.top_p = params.topP;
  }

  return request;
}

export function createBedrockAdapter(): ProviderAdapter {
  const awsRegion = resolveRegion();
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

      if (params.zodSchema) {
        const parsed = await client.messages.parse(
          {
            ...baseRequest,
            output_config: { format: zodOutputFormat(params.zodSchema) },
          },
          requestOptions
        );
        message = parsed;

        if (parsed.parsed_output == null) {
          throw new Error('Bedrock API returned an empty structured response.');
        }
        const validated = params.zodSchema.parse(parsed.parsed_output);
        content = JSON.stringify(validated);
      } else {
        message = await client.messages.create(baseRequest, requestOptions);
        content = extractText(message);
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
