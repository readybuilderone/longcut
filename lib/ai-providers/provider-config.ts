import type { ProviderBehavior, ProviderKey } from './types';

// Bedrock is intentionally first: with no explicit AI_PROVIDER, any
// environment with AWS_REGION auto-selects Bedrock (see ADR 0001).
const PROVIDER_ORDER: ProviderKey[] = ['bedrock', 'grok', 'gemini', 'minimax'];

const PROVIDER_DEFAULT_MODELS: Record<ProviderKey, string> = {
  bedrock: 'anthropic.claude-sonnet-5',
  grok: 'grok-4-1-fast-non-reasoning',
  gemini: 'gemini-2.5-flash-lite',
  minimax: 'MiniMax-M3',
};

const PROVIDER_BEHAVIORS: Record<ProviderKey, ProviderBehavior> = {
  bedrock: {
    forceFullTranscriptTopicGeneration: false,
    forceSmartModeOnClient: true,
  },
  grok: {
    forceFullTranscriptTopicGeneration: true,
    forceSmartModeOnClient: true,
  },
  gemini: {
    forceFullTranscriptTopicGeneration: false,
    forceSmartModeOnClient: false,
  },
  minimax: {
    forceFullTranscriptTopicGeneration: false,
    forceSmartModeOnClient: true,
  },
};

// The Bedrock guard is a region, not an API key: AWS credentials resolve via
// the standard chain (env keys, profile, IAM role), so key presence would
// misfire in role-based environments (see ADR 0001).
const PROVIDER_ENV_GUARDS: Record<ProviderKey, () => string | undefined> = {
  bedrock: () => process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION,
  grok: () => process.env.XAI_API_KEY,
  gemini: () => process.env.GEMINI_API_KEY,
  minimax: () => process.env.MINIMAX_API_KEY,
};

export function getProviderEnvGuard(key: ProviderKey): () => string | undefined {
  return PROVIDER_ENV_GUARDS[key];
}

export function normalizeProviderKey(value?: string | null): ProviderKey | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (
    normalized === 'bedrock' ||
    normalized === 'grok' ||
    normalized === 'gemini' ||
    normalized === 'minimax'
  ) {
    return normalized;
  }

  return undefined;
}

export function getConfiguredProviderKey(preferred?: string): ProviderKey | undefined {
  return normalizeProviderKey(
    preferred ?? process.env.AI_PROVIDER ?? process.env.NEXT_PUBLIC_AI_PROVIDER
  );
}

export function getEffectiveProviderKey(preferred?: string): ProviderKey {
  const configuredProvider = getConfiguredProviderKey(preferred);

  if (configuredProvider) {
    return configuredProvider;
  }

  for (const key of PROVIDER_ORDER) {
    if (PROVIDER_ENV_GUARDS[key]()) {
      return key;
    }
  }

  // Nothing configured: every provider fails at construction anyway, so this
  // only picks which error the user sees — keep it consistent with the order.
  return PROVIDER_ORDER[0];
}

export function getProviderDefaultModel(key: ProviderKey): string {
  return PROVIDER_DEFAULT_MODELS[key];
}

export function getProviderModelDefaults(preferred?: string): {
  defaultModel: string;
  fastModel: string;
  proModel: string;
} {
  const providerKey = getEffectiveProviderKey(preferred);
  const defaultModel =
    process.env.AI_DEFAULT_MODEL ?? getProviderDefaultModel(providerKey);
  const fastModel = process.env.AI_FAST_MODEL ?? defaultModel;
  const proModel = process.env.AI_PRO_MODEL ?? fastModel;

  return {
    defaultModel,
    fastModel,
    proModel,
  };
}

export function getProviderBehavior(key: ProviderKey): ProviderBehavior {
  return PROVIDER_BEHAVIORS[key];
}

export function getProviderPriorityOrder(): ProviderKey[] {
  return [...PROVIDER_ORDER];
}

export function getProviderFallbackOrder(
  currentKey?: ProviderKey,
  availableKeys?: ProviderKey[]
): ProviderKey[] {
  const available = availableKeys ? new Set(availableKeys) : undefined;

  return PROVIDER_ORDER.filter((key) => {
    if (key === currentKey) {
      return false;
    }

    return available ? available.has(key) : true;
  });
}
