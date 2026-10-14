import { app, type BrowserWindow, desktopCapturer, ipcMain, type IpcMainInvokeEvent, powerMonitor, screen, session } from 'electron';
import * as nodePty from 'node-pty';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';
import { IPC } from '../shared/ipc';
import { captureAutotest, createTerminalTap, terminalAutotest, uiSnapshotAutotest, visibilityAutotest } from './autotest';
import { classifyEnvironment } from './capture/detect';
import { ProtectionController } from './capture/ProtectionController';
import { createKwinProvider } from './capture/providers/kwin';
import { createUnsupportedProvider } from './capture/providers/unsupported';
import { SelfTestRunner } from './capture/selftest/SelfTestRunner';
import { config, sessionEnv, shellParentEnv } from './config';
import { isFromWindow } from './ipc-guard';
import { buildChildEnv } from './terminal/env';
import { PtyManager } from './terminal/PtyManager';
import { registerTerminalIpc } from './terminal/register';
import { detectShellProfiles } from './terminal/shells';
import { registerVisibility } from './visibility/register';
import { createWindow } from './window';

const ScreencastReportSchema = z
  .object({
    protectedFound: z.boolean(),
    controlFound: z.boolean(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
    error: z.string().max(500).optional(),
  })
  .strict();

// A terminal running as root under a GUI is never what a user wants, and Chromium's sandbox refuses it anyway.
if (process.getuid?.() === 0) {
  console.error('InviTerminal refuses to run as root.');
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.exit(0);

let mainWin: BrowserWindow | null = null;
let runner: SelfTestRunner | null = null;

function hardenSession(): void {
  const s = session.defaultSession;
  // Deny every permission except screen capture while a screencast self-test is running.
  const allowed = (permission: string) => (permission === 'display-capture' || permission === 'media') && runner?.screencastActive === true;
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed(permission)));
  s.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  s.setDisplayMediaRequestHandler((_req, callback) => {
    if (!runner?.screencastActive) {
      callback({});
      return;
    }
    // On Wayland this opens the xdg-desktop-portal picker and returns the user's choice.
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });
}

function guard<A extends unknown[], R>(fn: (...args: A) => R) {
  return (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!isFromWindow(e, mainWin)) throw new Error('IPC from unexpected sender');
    return fn(...args);
  };
}

function createPtyManager(tap: ReturnType<typeof createTerminalTap> | null): PtyManager {
  let etcShells = '';
  try {
    etcShells = readFileSync('/etc/shells', 'utf8');
  } catch {
    // Handled below: detection falls back to $SHELL, or throws if nothing is usable.
  }
  const profiles = detectShellProfiles({
    etcShells,
    userShell: sessionEnv.SHELL,
    isExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (p) => realpathSync(p),
  });
  return new PtyManager((file, args, opts) => nodePty.spawn(file, args, opts), profiles, () => buildChildEnv(shellParentEnv(), app.getVersion()), homedir(), {
    data: (sessionId, data) => {
      tap?.output.set(sessionId, [...(tap.output.get(sessionId) ?? []), data]);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.termData, sessionId, data);
    },
    exit: (sessionId, exitCode, signal) => {
      tap?.exits.set(sessionId, exitCode);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.termExit, sessionId, exitCode, signal ?? null);
    },
  });
}

app.whenReady().then(() => {
  hardenSession();
  // Autotests type into a real shell and take screenshots: development builds only.
  const autotest = app.isPackaged ? 'off' : config.autotest;

  const env = classifyEnvironment(process.platform, sessionEnv);
  const provider = env.kind === 'kwin-wayland' ? createKwinProvider() : createUnsupportedProvider(env.reason);

  const tap = autotest === 'terminal' || autotest === 'ui-snapshot' || autotest === 'visibility' ? createTerminalTap() : null;
  const manager = createPtyManager(tap);
  if (tap) {
    const spawn = manager.spawn.bind(manager);
    manager.spawn = (profileId) => {
      const info = spawn(profileId);
      tap.spawned.push({ sessionId: info.sessionId, pid: info.pid });
      return info;
    };
  }
  registerTerminalIpc(() => mainWin, manager);

  const win = createWindow('main', { title: config.mainTitle, width: 980, height: 680 });
  mainWin = win;
  const controller = new ProtectionController(provider, win, (s) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.state, s);
  });
  runner = new SelfTestRunner(win, () => createWindow('control', { title: config.controlTitle, width: 640, height: 260 }));
  const r = runner;
  const visibility = registerVisibility(win);

  // A hidden-then-shown Wayland window is a new KWin window with the flag cleared, so every show re-applies.
  let first = true;
  win.on('show', () => {
    const done = first ? controller.initialise() : controller.protect();
    if (first && autotest === 'screenshot') void done.then(() => captureAutotest(win, controller, r));
    if (first && tap && autotest === 'terminal') void done.then(() => terminalAutotest(win, manager, tap));
    if (first && tap && autotest === 'visibility') {
      const childEnv = buildChildEnv(shellParentEnv(), app.getVersion());
      void done.then(() => visibilityAutotest(win, manager, tap, controller, visibility, r, childEnv));
    }
    if (first && tap && autotest === 'ui-snapshot' && config.snapshotPath) {
      const out = config.snapshotPath;
      void done.then(() => uiSnapshotAutotest(win, manager, tap, out, controller));
    }
    first = false;
  });

  const recheck = () => {
    if (!win.isDestroyed() && win.isVisible()) void controller.recheck();
  };
  const interval = setInterval(recheck, config.recheckIntervalMs);
  screen.on('display-added', recheck);
  screen.on('display-removed', recheck);
  powerMonitor.on('resume', recheck);
  powerMonitor.on('unlock-screen', recheck);
  win.on('closed', () => {
    clearInterval(interval);
    // No shell may outlive the window it was typed into.
    manager.killAll();
    mainWin = null;
  });
  app.on('before-quit', () => manager.killAll());

  ipcMain.handle(IPC.getState, guard(() => controller.get()));
  ipcMain.handle(IPC.protect, guard(() => controller.protect()));
  ipcMain.handle(IPC.unprotect, guard(() => controller.unprotect()));
  ipcMain.handle(IPC.recheck, guard(() => controller.recheck()));
  ipcMain.handle(
    IPC.selfTestScreenshot,
    guard(async () => {
      const rec = await r.screenshot();
      controller.recordSelfTest(rec);
      return rec;
    }),
  );
  ipcMain.handle(IPC.selfTestScreencastPrepare, guard(() => r.prepareScreencast()));
  ipcMain.handle(
    IPC.selfTestScreencastReport,
    guard((raw: unknown) => {
      const { error, ...rest } = ScreencastReportSchema.parse(raw);
      const rec = r.reportScreencast(error === undefined ? rest : { ...rest, error });
      controller.recordSelfTest(rec);
      return rec;
    }),
  );
});

app.on('window-all-closed', () => app.quit());
