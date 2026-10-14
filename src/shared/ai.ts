// Groq (console.groq.com) — free, fast inference on open models.
export const AI_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'llama-3.3-70b-versatile';

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'llama-3.3-70b-versatile': 'Llama 3.3 70B (most capable)',
  'llama-3.1-8b-instant': 'Llama 3.1 8B (fastest)',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'openai/gpt-oss-20b': 'GPT-OSS 20B',
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
