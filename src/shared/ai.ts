export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 (most capable)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster, cheaper)',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fastest, cheapest)',
};

export type KeySource = 'env' | 'keychain' | 'none';

export interface KeyStatus {
  source: KeySource;
  /** Whether a key is usable right now (env or decryptable keychain). */
  present: boolean;
  /** True when the keychain is unavailable, so a pasted key cannot be saved. */
  keychainUnavailable: boolean;
  /** Masked hint for the UI, e.g. "sk-ant-…4f2a"; never the whole key. */
  hint: string | null;
}

export interface AiStatus {
  model: AiModel;
  key: KeyStatus;
}
