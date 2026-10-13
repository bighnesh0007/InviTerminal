import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/** Only the main window's own file:// page may drive the terminal, protection and self-tests. */
export function isFromWindow(e: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  return win !== null && !win.isDestroyed() && e.sender === win.webContents && (e.senderFrame?.url ?? '').startsWith('file://');
}
