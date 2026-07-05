# LongCut

Transforms long YouTube videos into topic-driven learning experiences by generating highlight reels, summaries, and chat over the transcript via pluggable AI text providers.

## Language

**Provider**:
A text-generation backend behind the adapter interface in `lib/ai-providers/` (grok, gemini, minimax, bedrock). Selected by `AI_PROVIDER` or auto-discovered by credential presence in priority order.
_Avoid_: Model vendor, LLM backend

**Bedrock provider**:
The provider that runs Claude models on AWS Bedrock via Anthropic's Mantle SDK. It is Claude-only — "Bedrock" here does not mean arbitrary Bedrock-hosted models (Nova, Llama, etc.).

**Provider guard**:
The environment-variable check that marks a provider as configured, gating auto-selection and fallback eligibility. For Bedrock the guard is `AWS_REGION`, not an API key.

**Provider behavior**:
Per-provider flags (`forceFullTranscriptTopicGeneration`, `forceSmartModeOnClient`) that tune how topic generation runs, independent of the adapter itself.

**Smart mode / Fast mode**:
Topic-generation modes. Smart produces base topics plus a candidate pool for theme exploration; fast produces quick initial highlights without candidates.
