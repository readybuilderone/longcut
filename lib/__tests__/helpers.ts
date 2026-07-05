// Shared test helpers. withEnv clears every provider-selection variable by
// default so tests are isolated from the host machine's environment (a real
// AWS_REGION on a CI runner must not flip provider auto-discovery).
const PROVIDER_SELECTION_DEFAULTS: Record<string, string | undefined> = {
  AI_PROVIDER: undefined,
  NEXT_PUBLIC_AI_PROVIDER: undefined,
  XAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  MINIMAX_API_KEY: undefined,
  AWS_REGION: undefined,
  AWS_BEDROCK_REGION: undefined,
  AI_DEFAULT_MODEL: undefined,
  AI_FAST_MODEL: undefined,
  AI_PRO_MODEL: undefined,
};

function applyEnv(values: Record<string, string | undefined>) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => T
): T {
  const restore = applyEnv({ ...PROVIDER_SELECTION_DEFAULTS, ...values });
  try {
    return run();
  } finally {
    restore();
  }
}

export function withEnvAsync<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const restore = applyEnv({ ...PROVIDER_SELECTION_DEFAULTS, ...values });
  return run().finally(restore);
}

export function withMockFetch<T>(
  mockFetch: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}
