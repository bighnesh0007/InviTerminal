import { type BrowserWindow, clipboard, ipcMain, type IpcMainEvent } from 'electron';
import type { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { PtyManager } from './PtyManager';
import { AckMessage, ClipboardWrite, InputMessage, KillMessage, ResizeMessage, SpawnRequest } from './schemas';

/**
 * Terminal IPC. High-frequency messages (input, resize, ack) are one-way
 * sends; anything malformed or from another sender is dropped, never thrown
 * back into the renderer.
 */
export function registerTerminalIpc(getWin: () => BrowserWindow | null, manager: PtyManager): void {
  function on<S extends z.ZodType>(channel: string, schema: S, handle: (msg: z.infer<S>) => void): void {
    ipcMain.on(channel, (e: IpcMainEvent, raw: unknown) => {
      if (!isFromWindow(e, getWin())) return;
      const parsed = schema.safeParse(raw);
      if (parsed.success) handle(parsed.data);
    });
  }

  function handle<S extends z.ZodType, R>(channel: string, schema: S, fn: (msg: z.infer<S>) => R): void {
    ipcMain.handle(channel, (e, raw: unknown) => {
      if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
      return fn(schema.parse(raw ?? {}));
    });
  }

  ipcMain.handle(IPC.termProfiles, (e) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    return manager.listProfiles();
  });
  handle(IPC.termSpawn, SpawnRequest, (m) => manager.spawn(m.profileId));
  on(IPC.termInput, InputMessage, (m) => manager.input(m.sessionId, m.data));
  on(IPC.termResize, ResizeMessage, (m) => manager.resize(m.sessionId, m.cols, m.rows));
  on(IPC.termAck, AckMessage, (m) => manager.ack(m.sessionId, m.chars));
  on(IPC.termKill, KillMessage, (m) => manager.kill(m.sessionId));

  ipcMain.handle(IPC.clipboardRead, (e) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    return clipboard.readText();
  });
  handle(IPC.clipboardWrite, ClipboardWrite, (m) => clipboard.writeText(m.text));
}
