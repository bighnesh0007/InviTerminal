import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { TtsSpeaker } from './TtsSpeaker';

const SpeakRequest = z.object({ text: z.string().min(1).max(8000) }).strict();

/** TTS IPC: the renderer asks main to speak a finished interviewer turn locally. */
export function registerTtsIpc(getWin: () => BrowserWindow | null, tts: TtsSpeaker): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };
  ipcMain.handle(IPC.ttsStatus, (e) => {
    guard(e);
    return tts.status();
  });
  ipcMain.handle(IPC.ttsSpeak, async (e, raw: unknown) => {
    guard(e);
    const { text } = SpeakRequest.parse(raw);
    await tts.speak(text);
  });
  // Fire-and-forget: stopping speech should not wait on a round trip.
  ipcMain.on(IPC.ttsStop, (e) => {
    if (isFromWindow(e, getWin())) tts.stop();
  });
}
