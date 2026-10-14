// Groq (console.groq.com) — free, fast inference on open models.
// Groq's Llama 3.x chat models were retired (shut down 2026-08-16); these are the
// general chat models confirmed available via the live models.list on 2026-10-15.
export const AI_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] as const;
export type AiModel = (typeof AI_MODELS)[number];
// Smallest/cheapest chat model and the most generous free-tier limits — the default so the free tier lasts.
export const DEFAULT_AI_MODEL: AiModel = 'openai/gpt-oss-20b';

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'openai/gpt-oss-20b': 'GPT-OSS 20B (cheapest, fastest — default)',
  'openai/gpt-oss-120b': 'GPT-OSS 120B (most capable)',
};

/** The provider name, shown in UI text ("send to …", "key stored …"). */
export const AI_PROVIDER = 'Groq';

export type KeySource = 'env' | 'keychain' | 'none';

export interface KeyStatus {
  source: KeySource;
  present: boolean;
  keychainUnavailable: boolean;
  /** Masked hint for the UI, e.g. "gsk_12…cdef"; never the whole key. */
  hint: string | null;
}

export interface AiStatus {
  model: AiModel;
  key: KeyStatus;
}
