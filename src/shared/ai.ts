// Groq (console.groq.com) — free, fast inference on open models.
export const AI_MODELS = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'] as const;
export type AiModel = (typeof AI_MODELS)[number];
// Smallest/cheapest model and the most generous free-tier limits — the default so the free tier lasts.
export const DEFAULT_AI_MODEL: AiModel = 'llama-3.1-8b-instant';

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'llama-3.1-8b-instant': 'Llama 3.1 8B (cheapest, fastest — default)',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B (most capable)',
  'openai/gpt-oss-20b': 'GPT-OSS 20B',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
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
