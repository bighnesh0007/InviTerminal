import { type BrowserWindow, ipcMain, nativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomSequence, type CanarySequence } from '../../../shared/canary';
import { findCanary, type Frame } from '../../../shared/detect-canary';
import { IPC, type ScreencastPrepared, type ScreencastReport } from '../../../shared/ipc';
import type { SelfTestRecord } from '../../../shared/protection';
import { judge } from '../../../shared/selftest-verdict';
import { config } from '../../config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitPainted(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(IPC.canaryPainted, onPainted);
      reject(new Error('window did not confirm the canary was painted'));
    }, timeoutMs);
    function onPainted(e: Electron.IpcMainEvent) {
      if (e.sender !== win.webContents) return;
      clearTimeout(timer);
      ipcMain.removeListener(IPC.canaryPainted, onPainted);
      resolve();
    }
    ipcMain.on(IPC.canaryPainted, onPainted);
  });
}

function runSpectacle(outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // --background: no UI; --nonotify: no desktop notification; --fullscreen: all monitors.
    execFile('spectacle', ['--background', '--nonotify', '--fullscreen', '--output', outFile], { timeout: config.screenshotTimeoutMs }, (err, _o, stderr) =>
      err ? reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'spectacle is not installed' : stderr.trim() || err.message)) : resolve(),
    );
  });
}

export interface CaptureFind {
  protectedFound: boolean;
  controlFound: boolean;
  width: number;
  height: number;
  order: Frame['order'];
}

/** Looks for both canaries in a bitmap; the control canary decides the byte order. */
export function findBoth(data: Uint8Array, width: number, height: number, seqs: { protectedSeq: CanarySequence; controlSeq: CanarySequence }): CaptureFind {
  for (const order of ['bgra', 'rgba'] as const) {
    const frame: Frame = { data, width, height, order };
    if (findCanary(frame, seqs.controlSeq).found) {
      return { protectedFound: findCanary(frame, seqs.protectedSeq).found, controlFound: true, width, height, order };
    }
  }
  const protectedFound = (['bgra', 'rgba'] as const).some((order) => findCanary({ data, width, height, order }, seqs.protectedSeq).found);
  return { protectedFound, controlFound: false, width, height, order: 'bgra' };
}

/**
 * Takes one full-desktop Spectacle screenshot and analyses it. The image
 * holds the whole screen, so it lives in a private temp dir and is deleted
 * before this returns.
 */
export async function spectacleFind(seqs: { protectedSeq: CanarySequence; controlSeq: CanarySequence }): Promise<CaptureFind> {
  const dir = await mkdtemp(join(tmpdir(), 'inviterminal-selftest-'));
  try {
    const file = join(dir, 'capture.png');
    await runSpectacle(file);
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) throw new Error('screenshot file could not be decoded');
    const { width, height } = img.getSize();
    return findBoth(img.toBitmap(), width, height, seqs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the canary self-test. The protected canary is drawn in the main
 * window; a second, deliberately unprotected window draws a different one.
 * A capture is only trusted if it contains the control canary.
 */
export class SelfTestRunner {
  private busy = false;
  private pendingScreencast: { seqs: ScreencastPrepared; control: BrowserWindow; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly mainWin: BrowserWindow,
    private readonly createControlWindow: () => BrowserWindow,
  ) {}

  get screencastActive(): boolean {
    return this.pendingScreencast !== null;
  }

  private newSequences(): ScreencastPrepared {
    const protectedSeq = randomSequence();
    let controlSeq = randomSequence();
    while (controlSeq.every((c, i) => c === protectedSeq[i])) controlSeq = randomSequence();
    return { protectedSeq, controlSeq };
  }

  private async showCanaries(seqs: ScreencastPrepared): Promise<BrowserWindow> {
    const control = this.createControlWindow();
    await new Promise<void>((resolve) => control.once('show', () => resolve()));
    const painted = Promise.all([waitPainted(this.mainWin, config.canaryPaintTimeoutMs), waitPainted(control, config.canaryPaintTimeoutMs)]);
    this.mainWin.webContents.send(IPC.canary, seqs.protectedSeq);
    control.webContents.send(IPC.canary, seqs.controlSeq);
    await painted;
    await sleep(config.compositorSettleMs);
    return control;
  }

  private hideCanaries(control: BrowserWindow): void {
    if (!this.mainWin.isDestroyed()) this.mainWin.webContents.send(IPC.canary, null);
    if (!control.isDestroyed()) control.close();
  }

  private record(path: SelfTestRecord['path'], protectedFound: boolean, controlFound: boolean, detail: string): SelfTestRecord {
    const { verdict, reason } = judge(protectedFound, controlFound);
    return { path, verdict, reason, detail, at: new Date().toISOString() };
  }

  private errorRecord(path: SelfTestRecord['path'], e: unknown): SelfTestRecord {
    return { path, verdict: 'inconclusive', reason: `The test could not run: ${(e as Error).message}`, detail: '', at: new Date().toISOString() };
  }

  /** KWin screenshot path, via Spectacle. Fully automatic. */
  async screenshot(): Promise<SelfTestRecord> {
    if (this.busy || this.pendingScreencast) return this.errorRecord('kwin-screenshot', new Error('another self-test is running'));
    this.busy = true;
    const seqs = this.newSequences();
    let control: BrowserWindow | null = null;
    try {
      control = await this.showCanaries(seqs);
      const r = await spectacleFind(seqs);
      const detail = `Spectacle full-desktop screenshot ${r.width}×${r.height}${r.controlFound ? `, byte order ${r.order}` : '; control canary not found'}.`;
      return this.record('kwin-screenshot', r.protectedFound, r.controlFound, detail);
    } catch (e) {
      return this.errorRecord('kwin-screenshot', e);
    } finally {
      if (control) this.hideCanaries(control);
      this.busy = false;
    }
  }

  /**
   * Opens the unprotected control window with its own canary, runs `fn`, and
   * closes it. For tests whose protected canary is drawn by something else
   * (e.g. the shell itself).
   */
  async withControlWindow<T>(fn: (controlSeq: CanarySequence) => Promise<T>): Promise<T> {
    const controlSeq = randomSequence();
    const control = this.createControlWindow();
    try {
      await new Promise<void>((resolve) => control.once('show', () => resolve()));
      const painted = waitPainted(control, config.canaryPaintTimeoutMs);
      control.webContents.send(IPC.canary, controlSeq);
      await painted;
      await sleep(config.compositorSettleMs);
      return await fn(controlSeq);
    } finally {
      if (!control.isDestroyed()) control.close();
    }
  }

  /**
   * Portal screencast path: the same xdg-desktop-portal → PipeWire route a
   * browser uses for Meet. The renderer does the capture because only it can
   * call getDisplayMedia; the user picks the screen in the portal dialog.
   */
  async prepareScreencast(): Promise<ScreencastPrepared> {
    if (this.busy || this.pendingScreencast) throw new Error('another self-test is running');
    this.busy = true;
    try {
      const seqs = this.newSequences();
      const control = await this.showCanaries(seqs);
      const timer = setTimeout(() => this.finishScreencast(), config.screencastTimeoutMs);
      this.pendingScreencast = { seqs, control, timer };
      return seqs;
    } finally {
      this.busy = false;
    }
  }

  reportScreencast(r: ScreencastReport): SelfTestRecord {
    if (!this.pendingScreencast) return this.errorRecord('portal-screencast', new Error('no screencast self-test in progress'));
    this.finishScreencast();
    if (r.error) return this.errorRecord('portal-screencast', new Error(r.error));
    return this.record('portal-screencast', r.protectedFound, r.controlFound, `Portal screencast ${r.width}×${r.height}, ${r.frames} frames analysed.`);
  }

  private finishScreencast(): void {
    const p = this.pendingScreencast;
    if (!p) return;
    clearTimeout(p.timer);
    this.hideCanaries(p.control);
    this.pendingScreencast = null;
  }
}

