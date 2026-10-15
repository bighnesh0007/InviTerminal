import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { type AiModel, ANSWER_LENGTHS, type AnswerLength } from '../../shared/ai';
import { IPC } from '../../shared/ipc';
import { redactSecrets } from '../../shared/redact';
import { isFromWindow } from '../ipc-guard';

/** Injectable so autotests stub the model. Streams the answer; returns the full text. */
export type AnswerStreamer = (
  opts: { model: AiModel; text: string; length: AnswerLength },
  onDelta: (chunk: string) => void,
  signal: AbortSignal,
) => Promise<string>;

const AskRequest = z.object({ id: z.number().int(), text: z.string().trim().min(1).max(16_000), length: z.enum(ANSWER_LENGTHS) }).strict();

/**
 * "Ask AI" about a single transcript line. One answer in flight at a time (a new ask cancels
 * the previous). The line is redacted for obvious secrets before it leaves the machine — the
 * same guard the Explain flow uses. Results stream back tagged with the line's id.
 */
/**
 * @param onResult called with the (already-redacted) question and the full answer when one
 * completes — wired to the phone companion so answers also appear there when sharing is on.
 */
export function registerLiveAnswerIpc(
  getWin: () => BrowserWindow | null,
  streamer: AnswerStreamer,
  getModel: () => AiModel,
  onResult: (question: string, answer: string) => void = () => {},
): void {
  let active: AbortController | null = null;

  const send = (channel: string, ...args: unknown[]) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  ipcMain.handle(IPC.liveAsk, async (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    const { id, text, length } = AskRequest.parse(raw);
    active?.abort();
    const controller = new AbortController();
    active = controller;
    // Authoritative redaction in main — never trust the renderer to have masked secrets.
    const safe = redactSecrets(text).redacted;
    try {
      const full = await streamer({ model: getModel(), text: safe, length }, (chunk) => send(IPC.liveAnswerDelta, { id, chunk }), controller.signal);
      send(IPC.liveAnswerDone, { id, full });
      if (full.trim()) onResult(safe, full);
    } catch (err) {
      if (!controller.signal.aborted) send(IPC.liveAnswerError, { id, message: (err as Error).message });
    } finally {
      if (active === controller) active = null;
    }
  });

  ipcMain.on(IPC.liveAskCancel, (e) => {
    if (isFromWindow(e, getWin())) active?.abort();
  });
}
