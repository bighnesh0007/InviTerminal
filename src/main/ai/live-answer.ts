import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { type AiModel, ANSWER_LENGTHS, type AnswerLength, ASK_MODES, type AskMode, type ChatTurn } from '../../shared/ai';
import { IPC } from '../../shared/ipc';
import { redactSecrets } from '../../shared/redact';
import { isFromWindow } from '../ipc-guard';

/** Injectable so autotests stub the model. Streams the answer; returns the full text. */
export type AnswerStreamer = (
  opts: { model: AiModel; text: string; length: AnswerLength; mode: AskMode; history: ChatTurn[] },
  onDelta: (chunk: string) => void,
  signal: AbortSignal,
) => Promise<string>;

const Turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(16_000) }).strict();
const AskRequest = z
  .object({
    id: z.number().int(),
    text: z.string().trim().min(1).max(16_000),
    length: z.enum(ANSWER_LENGTHS),
    mode: z.enum(ASK_MODES).optional(),
    // A follow-up thread is short; cap it so a runaway thread can't balloon the request.
    history: z.array(Turn).max(20).optional(),
  })
  .strict();

/**
 * "Ask AI" about transcript text: one line, a selection, a follow-up in a thread, or a
 * "summarize so far". One answer in flight at a time: the renderer queues asks, and a stray
 * concurrent ask (or a reset) aborts the one in flight. Every
 * piece of text — including the follow-up history — is redacted for obvious secrets in main
 * before it leaves the machine. Results stream back tagged with the request id.
 *
 * @param onResult called with the redacted question, the full answer and the mode when one
 * completes — wired to the phone companion so answers also appear there when sharing is on.
 */
export function registerLiveAnswerIpc(
  getWin: () => BrowserWindow | null,
  streamer: AnswerStreamer,
  getModel: () => AiModel,
  onResult: (question: string, answer: string, mode: AskMode) => void = () => {},
): void {
  let active: AbortController | null = null;

  const send = (channel: string, ...args: unknown[]) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  ipcMain.handle(IPC.liveAsk, async (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    const { id, text, length, mode = 'answer', history = [] } = AskRequest.parse(raw);
    active?.abort();
    const controller = new AbortController();
    active = controller;
    // Authoritative redaction in main — never trust the renderer to have masked secrets.
    const safe = redactSecrets(text).redacted;
    const safeHistory = history.map((t) => ({ role: t.role, content: redactSecrets(t.content).redacted }));
    try {
      const full = await streamer({ model: getModel(), text: safe, length, mode, history: safeHistory }, (chunk) => send(IPC.liveAnswerDelta, { id, chunk }), controller.signal);
      send(IPC.liveAnswerDone, { id, full });
      if (full.trim()) onResult(safe, full, mode);
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
