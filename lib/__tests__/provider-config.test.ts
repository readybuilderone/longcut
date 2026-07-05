import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getEffectiveProviderKey,
  getProviderModelDefaults,
  getProviderBehavior,
  getProviderDefaultModel,
  getProviderFallbackOrder,
  normalizeProviderKey,
} from '../ai-providers/provider-config';

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

test('provider-key normalization accepts MiniMax', () => {
  assert.equal(normalizeProviderKey('MiniMax'), 'minimax');
});

test('provider-key normalization accepts Bedrock', () => {
  assert.equal(normalizeProviderKey('Bedrock'), 'bedrock');
});

test('provider behavior forceFullTranscriptTopicGeneration is enabled only for Grok', () => {
  assert.equal(
    getProviderBehavior('grok').forceFullTranscriptTopicGeneration,
    true
  );
  assert.equal(
    getProviderBehavior('gemini').forceFullTranscriptTopicGeneration,
    false
  );
  assert.equal(
    getProviderBehavior('minimax').forceFullTranscriptTopicGeneration,
    false
  );
  assert.equal(
    getProviderBehavior('bedrock').forceFullTranscriptTopicGeneration,
    false
  );
});

test('provider behavior forceSmartModeOnClient is enabled for Grok, MiniMax, and Bedrock', () => {
  assert.equal(getProviderBehavior('grok').forceSmartModeOnClient, true);
  assert.equal(getProviderBehavior('minimax').forceSmartModeOnClient, true);
  assert.equal(getProviderBehavior('bedrock').forceSmartModeOnClient, true);
  assert.equal(getProviderBehavior('gemini').forceSmartModeOnClient, false);
});

test('deterministic fallback order prefers Bedrock before Grok before Gemini before MiniMax', () => {
  assert.deepEqual(getProviderFallbackOrder('minimax'), [
    'bedrock',
    'grok',
    'gemini',
  ]);
  assert.deepEqual(getProviderFallbackOrder('gemini'), [
    'bedrock',
    'grok',
    'minimax',
  ]);
  assert.deepEqual(getProviderFallbackOrder('grok'), [
    'bedrock',
    'gemini',
    'minimax',
  ]);
  assert.deepEqual(getProviderFallbackOrder('bedrock'), [
    'grok',
    'gemini',
    'minimax',
  ]);
});

test('provider default model returns MiniMax-M3 for MiniMax', () => {
  assert.equal(getProviderDefaultModel('minimax'), 'MiniMax-M3');
});

test('provider default model returns Bedrock-prefixed Claude Sonnet for Bedrock', () => {
  assert.equal(getProviderDefaultModel('bedrock'), 'anthropic.claude-sonnet-4-6');
});

test('provider model defaults derive fast and pro topic models from configured MiniMax provider', () => {
  withEnv(
    {
      AI_PROVIDER: 'minimax',
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.deepEqual(getProviderModelDefaults(), {
        defaultModel: 'MiniMax-M3',
        fastModel: 'MiniMax-M3',
        proModel: 'MiniMax-M3',
      });
    }
  );
});

test('effective provider resolves to MiniMax when only MINIMAX_API_KEY is present', () => {
  withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: 'test-minimax-key',
      AWS_REGION: undefined,
      AWS_BEDROCK_REGION: undefined,
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.equal(getEffectiveProviderKey(), 'minimax');
      assert.deepEqual(getProviderModelDefaults(), {
        defaultModel: 'MiniMax-M3',
        fastModel: 'MiniMax-M3',
        proModel: 'MiniMax-M3',
      });
    }
  );
});

test('effective provider resolves to Bedrock when only AWS_REGION is present', () => {
  withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
      AWS_REGION: 'us-east-1',
      AWS_BEDROCK_REGION: undefined,
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.equal(getEffectiveProviderKey(), 'bedrock');
      assert.deepEqual(getProviderModelDefaults(), {
        defaultModel: 'anthropic.claude-sonnet-4-6',
        fastModel: 'anthropic.claude-sonnet-4-6',
        proModel: 'anthropic.claude-sonnet-4-6',
      });
    }
  );
});

test('Bedrock outranks other providers in credential auto-discovery', () => {
  withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: 'test-xai-key',
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
      AWS_REGION: 'us-east-1',
      AWS_BEDROCK_REGION: undefined,
      AI_DEFAULT_MODEL: undefined,
      AI_FAST_MODEL: undefined,
      AI_PRO_MODEL: undefined,
    },
    () => {
      assert.equal(getEffectiveProviderKey(), 'bedrock');
    }
  );
});

test('explicit AI_PROVIDER overrides Bedrock auto-discovery (ADR 0001 escape hatch)', () => {
  withEnv(
    {
      AI_PROVIDER: 'minimax',
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      MINIMAX_API_KEY: 'test-minimax-key',
      AWS_REGION: 'us-east-1',
      AWS_BEDROCK_REGION: undefined,
    },
    () => {
      assert.equal(getEffectiveProviderKey(), 'minimax');
    }
  );
});
