import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import type { AiModel } from '../../shared/ai';
import { IPC } from '../../shared/ipc';
import { redactSecrets } from '../../shared/redact';
import { isFromWindow } from '../ipc-guard';

export const EXPLAIN_SYSTEM =
  'You help a developer understand terminal output. You are given text copied from a terminal (an error, a stack trace, a command and its output, logs). ' +
  'Explain what it means concisely, then, when there is a fix, show it as the exact command(s) to run. Do not invent file contents you were not shown. ' +
  'If the text was truncated or redacted (you may see «redacted:…» placeholders), say what you would need to be sure.';

/** Injectable so tests can stub the model without a network call. Returns the full answer. */
export type ExplainStreamer = (
  opts: { model: AiModel; system: string; text: string; imageBase64?: string },
  onDelta: (chunk: string) => void,
  signal: AbortSignal,
) => Promise<string>;

const ExplainRequest = z
  .object({
    text: z.string().min(1).max(200_000),
    redact: z.boolean(),
    wantImage: z.boolean(),
  })
  .strict();

const MAX_LINES = 400;

/** Trims very long selections to the last N lines so a huge paste doesn't balloon the request. */
function clampLines(text: string): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= MAX_LINES) return { text, truncated: false };
  return { text: `[… earlier ${lines.length - MAX_LINES} lines omitted …]\n${lines.slice(-MAX_LINES).join('\n')}`, truncated: true };
}

/**
 * Explain-terminal-output IPC. One request in flight at a time. The main
 * process is authoritative about what is sent: it re-applies redaction (never
 * trusting the renderer) and captures the image itself. Nothing is sent until
 * the renderer calls start — the renderer shows a confirm-preview first.
 */
export function registerExplainIpc(getWin: () => BrowserWindow | null, streamer: ExplainStreamer, getModel: () => AiModel, onResult: (text: string) => void = () => {}): void {
  let active: AbortController | null = null;

  const send = (channel: string, ...args: unknown[]) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  ipcMain.on(IPC.aiExplainCancel, (e) => {
    if (isFromWindow(e, getWin())) active?.abort();
  });

  ipcMain.handle(IPC.aiExplainStart, async (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    if (active) throw new Error('An explanation is already in progress.');
    const req = ExplainRequest.parse(raw);
    const win = getWin();
    if (!win) throw new Error('No window.');

    // Authoritative redaction: the renderer previews, the main process enforces.
    const redacted = req.redact ? redactSecrets(req.text).redacted : req.text;
    const { text } = clampLines(redacted);

    let imageBase64: string | undefined;
    if (req.wantImage) {
      try {
        imageBase64 = (await win.webContents.capturePage()).toPNG().toString('base64');
      } catch {
        // Non-fatal: send text only.
      }
    }

    active = new AbortController();
    const controller = active;
    (async () => {
      try {
        const full = await streamer({ model: getModel(), system: EXPLAIN_SYSTEM, text, ...(imageBase64 ? { imageBase64 } : {}) }, (chunk) => send(IPC.aiExplainDelta, chunk), controller.signal);
        send(IPC.aiExplainDone, full);
        onResult(full);
      } catch (err) {
        send(controller.signal.aborted ? IPC.aiExplainCancelled : IPC.aiExplainError, (err as Error).message);
      } finally {
        if (active === controller) active = null;
      }
    })();
    // Resolve immediately; results stream over events.
    return;
  });
}
