import { BrowserWindow, shell } from 'electron';
import { isProductionBuild } from './build-mode';
import path from 'node:path';

export type WindowRole = 'main' | 'control';

/**
 * Every window goes through here so the security settings cannot drift
 * between windows. The renderer gets no Node access; the preload exposes
 * a small typed API instead.
 */
export function createWindow(role: WindowRole, opts: { title: string; width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    title: opts.title,
    width: opts.width,
    height: opts.height,
    show: false,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !isProductionBuild(),
    },
  });

  // The page must keep the title we set; a page-driven title would leak
  // into window pickers and task switchers.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!isProductionBuild()) {
    // Surfaces renderer errors (CSP violations especially) in the dev console.
    win.webContents.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') console.log(`[renderer:${role}:${details.level}] ${details.message}`);
    });
  }

  void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { role } });
  win.once('ready-to-show', () => win.show());
  return win;
}
