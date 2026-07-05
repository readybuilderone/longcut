import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnvAsync as withEnv } from './helpers';

async function importFreshValidationModule() {
  return import(new URL(`../validation.ts?ts=${Date.now()}`, import.meta.url).href);
}

test('model schema defaults to MiniMax model when only MINIMAX_API_KEY is present', async () => {
  await withEnv(
    {
      AI_PROVIDER: undefined,
      NEXT_PUBLIC_AI_PROVIDER: undefined,
      XAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      MINIMAX_API_KEY: 'test-minimax-key',
      AWS_REGION: undefined,
      AWS_BEDROCK_REGION: undefined,
      AI_DEFAULT_MODEL: undefined,
    },
    async () => {
      const { modelSchema } = await importFreshValidationModule();
      assert.equal(modelSchema.parse(undefined), 'MiniMax-M3');
    }
  );
});
