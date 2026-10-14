import type Anthropic from '@anthropic-ai/sdk';
import { AI_MODELS, type AiModel } from '../../shared/ai';

/**
 * Thin wrapper over @anthropic-ai/sdk. The SDK is loaded lazily on first use
 * (like Mongoose) so the --toggle second process never parses ~13 MB of it,
 * and so the app starts without a key configured.
 */
type SdkModule = typeof import('@anthropic-ai/sdk');
let sdk: Promise<SdkModule> | null = null;
const loadSdk = (): Promise<SdkModule> => (sdk ??= import('@anthropic-ai/sdk'));

export interface TestResult {
  ok: boolean;
  detail: string;
}

export class AnthropicClient {
  /** @param getKey main-process-only key accessor; the key never passes through here into logs. */
  constructor(private readonly getKey: () => Promise<string | null>) {}

  private async client(): Promise<Anthropic> {
    const key = await this.getKey();
    if (!key) throw new Error('No Anthropic API key is configured.');
    const { default: Anthropic } = await loadSdk();
    // baseURL honours ANTHROPIC_BASE_URL if the SDK picks it up; apiKey is explicit.
    return new Anthropic({ apiKey: key });
  }

  /** Cheapest possible auth check: count_tokens is free and validates the key. */
  async testKey(model: AiModel): Promise<TestResult> {
    try {
      const client = await this.client();
      const r = await client.messages.countTokens({ model, messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true, detail: `Key works (${r.input_tokens} input tokens for a test message, model ${model}).` };
    } catch (e) {
      return { ok: false, detail: describeError(e) };
    }
  }

  /**
   * Streams an explanation of terminal content. `onDelta` receives text chunks.
   * Returns the full text. Throws on auth/validation errors (caller reports).
   */
  async explainStream(opts: { model: AiModel; system: string; text: string; imageBase64?: string }, onDelta: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    const client = await this.client();
    const content: Anthropic.ContentBlockParam[] = [];
    if (opts.imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: opts.imageBase64 } });
    content.push({ type: 'text', text: opts.text });

    const stream = client.messages.stream(
      {
        model: opts.model,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: opts.system,
        messages: [{ role: 'user', content }],
      },
      signal ? { signal } : undefined,
    );
    stream.on('text', (t) => onDelta(t));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('The model declined to answer this request.');
    return final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  }
}

function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string; name?: string };
  if (err.status === 401) return 'The key was rejected (401). Check that it is a valid Anthropic API key.';
  if (err.status === 403) return 'The key is not authorised for this model (403).';
  if (err.status === 429) return 'Rate limited (429). Try again shortly.';
  if (err.status && err.status >= 500) return `Anthropic service error (${err.status}). Try again later.`;
  return (err.message ?? 'Unknown error').slice(0, 200);
}

export { AI_MODELS };
