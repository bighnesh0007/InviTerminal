import { app, type BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { AudioStatus } from '../../shared/audio';
import { AUDIO_KIND_LABEL } from '../../shared/audio';
import { parseCliAction } from './cli';
import { VisibilityController } from './VisibilityController';

/** Long enough for any VisibilityController timeout; only cleans up the listener. */
const CONCEAL_LISTENER_TTL_MS = 2000;

let concealToken = 0;

/** Asks the renderer to cover its content and resolves once it reports the cover painted. */
function concealRenderer(win: BrowserWindow): Promise<void> {
  const token = ++concealToken;
  return new Promise((resolve) => {
    const onAck = (e: Electron.IpcMainEvent, t: unknown) => {
      if (!isFromWindow(e, win) || t !== token) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => cleanup(), CONCEAL_LISTENER_TTL_MS);
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener(IPC.concealed, onAck);
    };
    ipcMain.on(IPC.concealed, onAck);
    win.webContents.send(IPC.conceal, { token, at: new Date().toISOString() });
  });
}

export interface VisibilityWiring {
  controller: VisibilityController;
  tray: Tray | null;
  /** Runs a command-line action as if a second instance had sent it. */
  handleArgv(argv: readonly string[]): void;
  /** Updates the tray tooltip/menu to reflect a live mic recording (persistent indicator). */
  setRecording(status: AudioStatus, onStop: () => void): void;
}

export function registerVisibility(win: BrowserWindow): VisibilityWiring {
  const controller = new VisibilityController(win, () => concealRenderer(win));

  const handleArgv = (argv: readonly string[]) => {
    const action = parseCliAction(argv);
    if (action === 'toggle') void controller.toggle();
    else if (action === 'show') void controller.show();
    else if (action === 'hide') void controller.hide('cli');
    // A plain second launch means "bring it up".
    else void controller.show();
  };
  // `inviterminal --toggle` from a KDE custom shortcut lands here: the second process exits, this one acts.
  app.on('second-instance', (_e, argv) => handleArgv(argv));

  ipcMain.on(IPC.panicHide, (e) => {
    if (isFromWindow(e, win)) void controller.hide('panic');
  });

  let tray: Tray | null = null;
  const refreshTray = (rec?: { status: AudioStatus; onStop: () => void }) => {
    if (!tray) return;
    const recording = rec?.status.active ?? false;
    // The indicator is deliberately visible in a shared screen — the point is that recording is never hidden.
    tray.setToolTip(recording ? `InviTerminal — ● recording (${AUDIO_KIND_LABEL[rec!.status.kind!]})` : 'InviTerminal');
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: 'Show / Hide', click: () => void controller.toggle() },
      { label: 'Hide now', click: () => void controller.hide('panic') },
    ];
    if (recording) items.push({ type: 'separator' }, { label: '● Stop recording', click: () => rec!.onStop() });
    items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../assets/tray-icon.png')));
    refreshTray();
    tray.on('click', () => void controller.toggle());
  } catch (e) {
    // No StatusNotifier host (or similar): the app still works through the CLI and the window.
    console.warn(`Tray unavailable: ${(e as Error).message}`);
  }

  return { controller, tray, handleArgv, setRecording: (status, onStop) => refreshTray(status.active ? { status, onStop } : undefined) };
}
