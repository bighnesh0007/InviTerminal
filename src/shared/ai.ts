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

/** How long an "Ask AI" answer should be. */
export const ANSWER_LENGTHS = ['short', 'medium', 'detailed'] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];
export const ANSWER_LENGTH_LABELS: Record<AnswerLength, string> = {
  short: 'Short',
  medium: 'Medium',
  detailed: 'Detailed',
};

/** The instruction + output cap for each answer length, so the response (and cost) stays bounded. */
export function answerParams(length: AnswerLength): { instruction: string; maxTokens: number } {
  switch (length) {
    case 'short':
      return { instruction: 'Answer in 1–2 crisp sentences. No preamble.', maxTokens: 160 };
    case 'medium':
      return { instruction: 'Answer in a short paragraph (3–5 sentences). No preamble.', maxTokens: 450 };
    case 'detailed':
      return { instruction: 'Answer thoroughly but without padding: the key points, briefly explained.', maxTokens: 1024 };
  }
}

/** System prompt for answering a line pulled from a live conversation transcript. */
export function answerSystem(length: AnswerLength): string {
  return (
    'You are a concise assistant. The user gives you a line from a live conversation — usually a question or a prompt. ' +
    'Respond directly and helpfully, as if helping the user think it through. ' +
    answerParams(length).instruction
  );
}

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
