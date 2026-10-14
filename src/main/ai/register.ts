import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import type { AiModel, AiStatus } from '../../shared/ai';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { AnthropicClient } from './AnthropicClient';
import type { KeyStore } from './key-store';

const SetKeyRequest = z.object({ key: z.string().min(1).max(500) }).strict();

/**
 * AI IPC. The key crosses the boundary exactly once (renderer → main, on
 * aiSetKey) and is never sent back; status carries only a masked hint.
 */
export function registerAiIpc(getWin: () => BrowserWindow | null, keyStore: KeyStore, client: AnthropicClient, getModel: () => AiModel): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };

  const status = async (): Promise<AiStatus> => ({ model: getModel(), key: await keyStore.status() });
  const pushStatus = async () => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(IPC.aiStatusChanged, await status());
  };

  ipcMain.handle(IPC.aiStatus, (e) => {
    guard(e);
    return status();
  });
  ipcMain.handle(IPC.aiSetKey, async (e, raw: unknown) => {
    guard(e);
    try {
      await keyStore.setKey(SetKeyRequest.parse(raw).key);
      await pushStatus();
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  ipcMain.handle(IPC.aiClearKey, async (e) => {
    guard(e);
    await keyStore.clearKey();
    await pushStatus();
  });
  ipcMain.handle(IPC.aiTestKey, (e) => {
    guard(e);
    return client.testKey(getModel());
  });
}
