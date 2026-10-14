import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { LiveTranscriptController } from './LiveTranscriptController';

const StartRequest = z.object({ consent: z.boolean(), diarize: z.boolean().optional() }).strict();

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
    const { consent, diarize } = StartRequest.parse(raw);
    return live.start(consent, diarize ?? false);
  });
  ipcMain.handle(IPC.liveStop, async (e) => {
    guard(e);
    await live.stop();
  });
}
