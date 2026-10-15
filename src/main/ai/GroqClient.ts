import type Groq from 'groq-sdk';
import { type AiModel, AI_MODELS, type AnswerLength, answerParams, answerSystem } from '../../shared/ai';

/**
 * Thin wrapper over groq-sdk (console.groq.com — free, fast inference on open
 * models). Loaded lazily so the --toggle second process never parses it, and
 * so the app starts without a key configured. The OpenAI-compatible chat API
 * is used for both explain and interview practice.
 */
type SdkModule = typeof import('groq-sdk');
let sdk: Promise<SdkModule> | null = null;
const loadSdk = (): Promise<SdkModule> => (sdk ??= import('groq-sdk'));

export interface TestResult {
  ok: boolean;
  detail: string;
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export class GroqClient {
  /** @param getKey main-process-only key accessor; the key never passes through here into logs. */
  constructor(private readonly getKey: () => Promise<string | null>) {}

  private async client(): Promise<Groq> {
    const key = await this.getKey();
    if (!key) throw new Error('No Groq API key is configured.');
    const { default: Groq } = await loadSdk();
    return new Groq({ apiKey: key });
  }

  /** Validates the key and that the chosen model is available (models.list is free). */
  async testKey(model: AiModel): Promise<TestResult> {
    try {
      const client = await this.client();
      const list = await client.models.list();
      const ids = (list.data ?? []).map((m) => m.id);
      const present = ids.includes(model);
      return { ok: true, detail: present ? `Key works; model ${model} is available on Groq.` : `Key works, but model ${model} was not in your Groq model list. Pick another in Settings.` };
    } catch (e) {
      return { ok: false, detail: describeError(e) };
    }
  }

  /**
   * Streams an explanation of terminal content. An image is attached only when
   * `imageBase64` is present AND the model accepts images; otherwise text-only.
   */
  async explainStream(opts: { model: AiModel; system: string; text: string; imageBase64?: string }, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    const userContent: Groq.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: opts.text }];
    if (opts.imageBase64 && modelSupportsVision(opts.model)) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${opts.imageBase64}` } });
    }
    return this.run(
      opts.model,
      [
        { role: 'system', content: opts.system },
        { role: 'user', content: userContent },
      ],
      onDelta,
      signal,
    );
  }

  /** Multi-turn chat (interview practice). System prompt is sent as the first message. */
  async chatStream(opts: { model: AiModel; system: string; messages: ChatMessage[] }, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    return this.run(opts.model, [{ role: 'system', content: opts.system }, ...opts.messages], onDelta, signal);
  }

  /** Answer a single line (from the live transcript) at the requested length. */
  async answerStream(opts: { model: AiModel; text: string; length: AnswerLength }, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    return this.run(
      opts.model,
      [
        { role: 'system', content: answerSystem(opts.length) },
        { role: 'user', content: opts.text },
      ],
      onDelta,
      signal,
      answerParams(opts.length).maxTokens,
    );
  }

  private async run(model: AiModel, messages: Groq.Chat.Completions.ChatCompletionMessageParam[], onDelta: (chunk: string) => void, signal?: AbortSignal, maxTokens = 4096): Promise<string> {
    const client = await this.client();
    const stream = await client.chat.completions.create({ model, messages, max_tokens: maxTokens, stream: true }, signal ? { signal } : undefined);
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
    return full;
  }
}

/** No Groq model is confirmed vision-capable here, so images fall back to text-only with a note. */
function modelSupportsVision(_model: AiModel): boolean {
  return false;
}

export function imageFallbackNote(): string {
  return 'The current Groq model does not accept images, so only the text was sent.';
}

function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  if (err.status === 401) return 'The key was rejected (401). Check that it is a valid Groq API key (gsk_…).';
  if (err.status === 403) return 'The key is not authorised for this model (403).';
  if (err.status === 404) return 'Model not found (404). Pick a different model in Settings.';
  if (err.status === 429) return 'Rate limited (429) — Groq free tier limit. Try again shortly.';
  if (err.status && err.status >= 500) return `Groq service error (${err.status}). Try again later.`;
  return (err.message ?? 'Unknown error').slice(0, 200);
}

export { AI_MODELS };
