import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { AUDIO_KINDS } from '../../shared/audio';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { AudioController } from './AudioController';

const StartRequest = z.object({ kind: z.enum(AUDIO_KINDS) }).strict();

/** Audio-session IPC. Starting a session is what flips the mic permission gate on. */
export function registerAudioIpc(getWin: () => BrowserWindow | null, audio: AudioController): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };
  ipcMain.handle(IPC.audioStatus, (e) => {
    guard(e);
    return audio.get();
  });
  ipcMain.handle(IPC.audioStart, (e, raw: unknown) => {
    guard(e);
    try {
      audio.start(StartRequest.parse(raw).kind);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  ipcMain.handle(IPC.audioStop, (e) => {
    guard(e);
    audio.stop();
  });
  ipcMain.handle(IPC.audioConsentMeeting, (e) => {
    guard(e);
    audio.consentToMeeting();
  });
}
