import test from 'node:test';
import assert from 'node:assert/strict';

import { availableProviders, getProvider, getProviderKey } from '../ai-providers/registry';
import { withEnv } from './helpers';

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
      assert.equal(adapter.defaultModel, 'anthropic.claude-sonnet-5');
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
