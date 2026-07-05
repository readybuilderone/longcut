import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createBedrockAdapter } from '../ai-providers/bedrock-adapter';
import { withEnvAsync as withEnv, withMockFetch } from './helpers';

const BEDROCK_ENV = {
  AWS_REGION: 'us-east-1',
  AWS_BEDROCK_REGION: undefined,
  // Bearer auth short-circuits SigV4 credential resolution in the SDK,
  // so tests never touch the AWS credential chain.
  AWS_BEARER_TOKEN_BEDROCK: 'test-bearer-token',
};

type SseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; inputJson: string };

function sseMessageResponse(options: {
  model?: string;
  blocks: SseBlock[];
  inputTokens?: number;
  outputTokens?: number;
}): Response {
  const events: Array<[string, unknown]> = [];
  const model = options.model ?? 'claude-sonnet-5';

  events.push([
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: options.inputTokens ?? 10, output_tokens: 1 },
      },
    },
  ]);

  options.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      ]);
    } else {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: `toolu_${index}`,
            name: block.name,
            input: {},
          },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: block.inputJson },
        },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });

  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: options.outputTokens ?? 7 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);

  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

test('Bedrock adapter normalizes 429 into a retryable rate-limit error', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    await withMockFetch(
      (async () =>
        errorResponse(429, 'rate_limit_error', 'Too many requests.')) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        await assert.rejects(
          () => adapter.generate({ prompt: 'hi' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /rate limit/i);
            return true;
          }
        );
      }
    );
  });
});

test('Bedrock adapter normalizes 5xx/overload into a retryable service-unavailable error', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    await withMockFetch(
      (async () =>
        errorResponse(529, 'overloaded_error', 'Bedrock is overloaded.')) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        await assert.rejects(
          () => adapter.generate({ prompt: 'hi' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /service unavailable/i);
            return true;
          }
        );
      }
    );
  });
});

test('Bedrock adapter surfaces auth failures as clear non-retryable errors', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    await withMockFetch(
      (async () =>
        errorResponse(403, 'permission_error', 'Not authorized for model.')) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        await assert.rejects(
          () => adapter.generate({ prompt: 'hi' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /authentication failed/i);
            // Must NOT trip the registry's retryable-substring matching
            assert.doesNotMatch(
              error.message,
              /rate limit|service unavailable|overload|timeout/i
            );
            return true;
          }
        );
      }
    );
  });
});

test('Bedrock adapter maps timeoutMs onto the request and reports a timeout error', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    await withMockFetch(
      (async (input: any, init: any) =>
        new Promise((resolve, reject) => {
          // Hang until the SDK aborts via its timeout signal
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        const startedAt = Date.now();
        await assert.rejects(
          () => adapter.generate({ prompt: 'hi', timeoutMs: 300 }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /timeout/i);
            return true;
          }
        );
        // Aborted by our 300ms budget, not the SDK's 10-minute default
        assert.ok(Date.now() - startedAt < 5000);
      }
    );
  });
});

test('Bedrock adapter wraps schema-mismatched tool output as a structured-output validation error', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    const schema = z.array(z.object({ title: z.string() }));

    await withMockFetch(
      (async () =>
        sseMessageResponse({
          blocks: [
            {
              type: 'tool_use',
              name: 'emit_result',
              // title has the wrong type → Zod re-validation must fail
              inputJson: JSON.stringify({ result: [{ title: 42 }] }),
            },
          ],
        })) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        await assert.rejects(
          () => adapter.generate({ prompt: 'hi', zodSchema: schema }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /structured output validation failed/i);
            return true;
          }
        );
      }
    );
  });
});

test('Bedrock adapter clamps maxOutputTokens to the cap and logs the clamp', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    let requestBody: any;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      await withMockFetch(
        (async (input: any, init: any) => {
          requestBody = JSON.parse(init.body);
          return sseMessageResponse({ blocks: [{ type: 'text', text: 'ok' }] });
        }) as typeof fetch,
        async () => {
          const adapter = createBedrockAdapter();
          // The chat route requests 65536 — must clamp, succeed, and log
          const result = await adapter.generate({
            prompt: 'hi',
            maxOutputTokens: 65536,
          });
          assert.equal(requestBody.max_tokens, 64000);
          assert.equal(result.content, 'ok');
          assert.ok(
            warnings.some((w) => /clamp/i.test(w)),
            `expected a clamp warning, got: ${JSON.stringify(warnings)}`
          );
        }
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('createBedrockAdapter throws a configuration error when no region is set', async () => {
  await withEnv(
    { AWS_REGION: undefined, AWS_BEDROCK_REGION: undefined },
    async () => {
      assert.throws(
        () => createBedrockAdapter(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /AWS_REGION/);
          return true;
        }
      );
    }
  );
});

test('Bedrock adapter serves structured output for top-level array schemas', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    let requestBody: any;
    const schema = z.array(z.object({ title: z.string() }));

    await withMockFetch(
      (async (input: any, init: any) => {
        requestBody = JSON.parse(init.body);
        return sseMessageResponse({
          blocks: [
            {
              type: 'tool_use',
              name: 'emit_result',
              inputJson: JSON.stringify({
                result: [{ title: 'First topic' }, { title: 'Second topic' }],
              }),
            },
          ],
        });
      }) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        const result = await adapter.generate({
          prompt: 'List topics.',
          zodSchema: schema,
          schemaName: 'TopicList',
        });

        // Wire contract: forced tool call with an object-wrapped array schema
        assert.equal(requestBody.tool_choice.type, 'tool');
        assert.equal(requestBody.tools[0].input_schema.type, 'object');

        const parsed = schema.parse(JSON.parse(result.content));
        assert.deepEqual(parsed, [
          { title: 'First topic' },
          { title: 'Second topic' },
        ]);
      }
    );
  });
});

test('Bedrock adapter streams internally and returns a single result with normalized usage', async () => {
  await withEnv(BEDROCK_ENV, async () => {
    let requestBody: any;

    await withMockFetch(
      (async (input: any, init: any) => {
        requestBody = JSON.parse(init.body);
        return sseMessageResponse({
          blocks: [{ type: 'text', text: 'hello from bedrock' }],
          inputTokens: 11,
          outputTokens: 7,
        });
      }) as typeof fetch,
      async () => {
        const adapter = createBedrockAdapter();
        const result = await adapter.generate({ prompt: 'Say hello.' });

        assert.equal(requestBody.stream, true);
        assert.equal(result.content, 'hello from bedrock');
        assert.equal(result.provider, 'bedrock');
        assert.equal(result.model, 'claude-sonnet-5');
        assert.equal(result.usage?.promptTokens, 11);
        assert.equal(result.usage?.completionTokens, 7);
        assert.equal(result.usage?.totalTokens, 18);
        assert.equal(typeof result.usage?.latencyMs, 'number');
      }
    );
  });
});
