import { app, BrowserWindow, desktopCapturer, ipcMain, type IpcMainInvokeEvent, powerMonitor, screen, session } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/ipc';
import { classifyEnvironment } from './capture/detect';
import { ProtectionController } from './capture/ProtectionController';
import { createKwinProvider } from './capture/providers/kwin';
import { createUnsupportedProvider } from './capture/providers/unsupported';
import { SelfTestRunner } from './capture/selftest/SelfTestRunner';
import { config, sessionEnv } from './config';
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

/** Only the main window's own page may drive protection and self-tests. */
function fromMain(e: IpcMainInvokeEvent): boolean {
  return mainWin !== null && e.sender === mainWin.webContents && (e.senderFrame?.url ?? '').startsWith('file://');
}

function guard<A extends unknown[], R>(fn: (...args: A) => R) {
  return (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!fromMain(e)) throw new Error('IPC from unexpected sender');
    return fn(...args);
  };
}

app.whenReady().then(() => {
  hardenSession();

  const env = classifyEnvironment(process.platform, sessionEnv);
  const provider = env.kind === 'kwin-wayland' ? createKwinProvider() : createUnsupportedProvider(env.reason);

  const win = createWindow('main', { title: config.mainTitle, width: 980, height: 680 });
  mainWin = win;
  const controller = new ProtectionController(provider, win, (s) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.state, s);
  });
  runner = new SelfTestRunner(win, () => createWindow('control', { title: config.controlTitle, width: 640, height: 260 }));
  const r = runner;

  // A hidden-then-shown Wayland window is a new KWin window with the flag cleared, so every show re-applies.
  let first = true;
  win.on('show', () => {
    const done = first ? controller.initialise() : controller.protect();
    if (first && config.autotest === 'screenshot') void done.then(() => autotest(controller, r));
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
    mainWin = null;
  });

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

/**
 * Runs the screenshot self-test unprotected first: it must FAIL, or the
 * detector is not seeing real captures and a later PASS would mean nothing.
 */
async function autotest(controller: ProtectionController, r: SelfTestRunner): Promise<void> {
  const log = (event: string, data: unknown) => console.log(`[autotest] ${JSON.stringify({ event, ...(data as object) })}`);
  log('start', { level: controller.get().level, detail: controller.get().detail });
  await controller.unprotect();
  log('unprotected', { level: controller.get().level, detail: controller.get().detail });
  log('negative-control', await r.screenshot());
  await controller.protect();
  log('protected', { level: controller.get().level, detail: controller.get().detail });
  const rec = await r.screenshot();
  controller.recordSelfTest(rec);
  log('protected-test', rec);

  // Hide/show unmaps the Wayland surface; check what KWin does with the flag and that re-apply restores it.
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === config.mainTitle);
  if (win) {
    win.hide();
    await new Promise((res) => setTimeout(res, 800));
    await controller.recheck();
    log('after-hide', { level: controller.get().level, detail: controller.get().detail });
    const shown = new Promise<void>((res) => win.once('show', () => res()));
    win.show();
    await shown;
    await new Promise((res) => setTimeout(res, 2500));
    log('after-show', { level: controller.get().level, detail: controller.get().detail });
    const rec2 = await r.screenshot();
    controller.recordSelfTest(rec2);
    log('after-show-test', rec2);
  }
  log('final', { level: controller.get().level });
  app.quit();
}

app.on('window-all-closed', () => app.quit());
