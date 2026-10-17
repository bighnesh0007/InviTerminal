import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { UsageStore } from './UsageStore';

// The renderer sends a bare action ID; the store re-validates against the known set, so an
// unknown or oversized string is harmless (max length just bounds the payload).
const TrackRequest = z.object({ action: z.string().min(1).max(64) }).strict();

/**
 * Usage-telemetry IPC. `track` is a one-way, best-effort send that never throws back into the
 * renderer (a tracking failure must not disrupt whatever the user was doing). get/reset/export
 * are sender-checked invokes. Nothing here reads or writes anything but local counters.
 */
export function registerUsageIpc(getWin: () => BrowserWindow | null, store: UsageStore): void {
  const guard = (e: Electron.IpcMainInvokeEvent) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
  };

  ipcMain.on(IPC.usageTrack, (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) return;
    const parsed = TrackRequest.safeParse(raw);
    if (parsed.success) store.track(parsed.data.action);
  });

  ipcMain.handle(IPC.usageGet, (e) => {
    guard(e);
    return store.view();
  });

  ipcMain.handle(IPC.usageReset, async (e) => {
    guard(e);
    await store.reset();
    return store.view();
  });

  // Export goes through a native Save dialog, so the renderer never picks a filesystem path.
  ipcMain.handle(IPC.usageExport, async (e) => {
    guard(e);
    const win = getWin();
    const opts = { defaultPath: 'inviterminal-usage.json', filters: [{ name: 'JSON', extensions: ['json'] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, store.exportJson(), { mode: 0o600 });
    return res.filePath;
  });
}
