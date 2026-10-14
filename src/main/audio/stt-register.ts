import { type BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isWav } from '../../shared/wav';
import { isFromWindow } from '../ipc-guard';
import type { WhisperStt } from './WhisperStt';

// Up to ~10 min of 16 kHz mono 16-bit audio.
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const TranscribeRequest = z.object({ wav: z.instanceof(Uint8Array) }).strict();

/** STT IPC: the renderer sends WAV bytes; main transcribes locally and deletes the temp file. */
export function registerSttIpc(getWin: () => BrowserWindow | null, stt: WhisperStt): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };
  ipcMain.handle(IPC.sttStatus, (e) => {
    guard(e);
    return stt.status();
  });
  ipcMain.handle(IPC.sttTranscribe, async (e, raw: unknown) => {
    guard(e);
    const { wav } = TranscribeRequest.parse(raw);
    if (wav.byteLength > MAX_WAV_BYTES) throw new Error('Recording is too long.');
    if (!isWav(wav)) throw new Error('Not a WAV payload.');
    const dir = await mkdtemp(join(tmpdir(), 'inviterminal-stt-'));
    const file = join(dir, 'audio.wav');
    try {
      await writeFile(file, wav, { mode: 0o600 });
      return await stt.transcribe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
