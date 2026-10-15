import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { SPEAKER_MODES } from '../../shared/audio';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { LiveTranscriptController } from './LiveTranscriptController';

const StartRequest = z.object({ consent: z.boolean(), mode: z.enum(SPEAKER_MODES).optional() }).strict();
const ExportRequest = z.object({ markdown: z.string().max(5_000_000), suggestedName: z.string().max(200) }).strict();

/** Live-transcript IPC: start is consent-gated; status/lines/errors stream to the renderer. */
export function registerLiveIpc(getWin: () => BrowserWindow | null, live: LiveTranscriptController): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };
  ipcMain.handle(IPC.liveStatus, (e) => {
    guard(e);
    return live.status();
  });
  ipcMain.handle(IPC.liveStart, async (e, raw: unknown) => {
    guard(e);
    const { consent, mode } = StartRequest.parse(raw);
    return live.start(consent, mode ?? 'off');
  });
  ipcMain.handle(IPC.liveStop, async (e) => {
    guard(e);
    await live.stop();
  });
  ipcMain.handle(IPC.livePause, (e) => {
    guard(e);
    live.pause();
    return live.status();
  });
  ipcMain.handle(IPC.liveResume, (e) => {
    guard(e);
    live.resume();
    return live.status();
  });
  // Export goes through a native Save dialog, so the renderer never chooses a filesystem path itself.
  ipcMain.handle(IPC.liveExport, async (e, raw: unknown) => {
    guard(e);
    const { markdown, suggestedName } = ExportRequest.parse(raw);
    const win = getWin();
    const opts = { defaultPath: suggestedName.replace(/[^\w.\- ]+/g, '_'), filters: [{ name: 'Markdown', extensions: ['md'] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, markdown, { mode: 0o600 });
    return res.filePath;
  });
}
