import test from 'node:test';
import assert from 'node:assert/strict';

import { availableProviders, getProvider, getProviderKey } from '../ai-providers/registry';

function withEnv<T>(values: Record<string, string | undefined>, run: () => T) {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('registry constructs the Bedrock adapter when AWS_REGION is configured', () => {
  withEnv(
    {
      AI_PROVIDER: 'bedrock',
      AWS_REGION: 'us-east-1',
      AWS_BEDROCK_REGION: undefined,
    },
    () => {
      const adapter = getProvider('bedrock');
      assert.equal(adapter.name, 'bedrock');
      assert.equal(adapter.defaultModel, 'anthropic.claude-sonnet-4-6');
      assert.equal(typeof adapter.generate, 'function');
    }
  );
});

test('registry lists Bedrock among available providers when AWS_REGION is set', () => {
  withEnv(
    {
      AWS_REGION: 'us-east-1',
      AWS_BEDROCK_REGION: undefined,
    },
    () => {
      assert.ok(availableProviders().includes('bedrock'));
    }
  );
});

test('registry resolves the Bedrock key from AWS_BEDROCK_REGION alone', () => {
  withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      AWS_REGION: undefined,
      AWS_BEDROCK_REGION: 'eu-central-1',
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    () => {
      assert.equal(getProviderKey(), 'bedrock');
    }
  );
});
