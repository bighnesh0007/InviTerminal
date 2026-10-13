import { app, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { ProtectionController } from './capture/ProtectionController';
import type { SelfTestRunner } from './capture/selftest/SelfTestRunner';
import type { PtyManager } from './terminal/PtyManager';

/**
 * Development aid (INVI_AUTOTEST). Drives the real app against the real
 * compositor and a real shell, logs JSON lines prefixed "[autotest]", quits.
 */
const log = (event: string, data: object = {}) => console.log(`[autotest] ${JSON.stringify({ event, ...data })}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the screenshot self-test unprotected first: it must FAIL, or the
 * detector is not seeing real captures and a later PASS would mean nothing.
 */
export async function captureAutotest(win: BrowserWindow, controller: ProtectionController, r: SelfTestRunner): Promise<void> {
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
  win.hide();
  await sleep(800);
  await controller.recheck();
  log('after-hide', { level: controller.get().level, detail: controller.get().detail });
  const shown = new Promise<void>((res) => win.once('show', () => res()));
  win.show();
  await shown;
  await sleep(2500);
  log('after-show', { level: controller.get().level, detail: controller.get().detail });
  const rec2 = await r.screenshot();
  controller.recordSelfTest(rec2);
  log('after-show-test', rec2);
  log('final', { level: controller.get().level });
  app.quit();
}

export interface TerminalTap {
  /** Sessions spawned at the renderer's request, in order. */
  spawned: { sessionId: string; pid: number }[];
  output: Map<string, string[]>;
  exits: Map<string, number>;
}

export function createTerminalTap(): TerminalTap {
  return { spawned: [], output: new Map(), exits: new Map() };
}

async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Types into the renderer's own session (as the keyboard would) so output
 * flows through the real IPC → xterm.js → ack path, including flow control.
 */
export async function terminalAutotest(win: BrowserWindow, manager: PtyManager, tap: TerminalTap): Promise<void> {
  const nonce = randomBytes(4).toString('hex');
  const text = (id: string) => (tap.output.get(id) ?? []).join('');
  try {
    const first = await until('renderer to spawn a shell', () => tap.spawned[0], 10_000);
    log('spawned', { pid: first.pid, profiles: manager.listProfiles() });
    const id = first.sessionId;

    manager.input(id, `printf 'invi-%s\\n' ${nonce}\r`);
    await until('round-trip output', () => text(id).includes(`invi-${nonce}`), 5000);
    log('roundtrip', { ok: true });

    // The renderer fits xterm to the window and reports its size; the tty must agree.
    const stats = await until('a renderer resize', () => manager.stats(id)?.size ?? undefined, 5000);
    const mark = text(id).length;
    manager.input(id, `stty size; printf 'size-done-%s\\n' ${nonce}\r`);
    await until('stty output', () => text(id).includes(`size-done-${nonce}`), 5000);
    const stty = /(\d+) (\d+)\r?\n/.exec(text(id).slice(mark).split(`stty size`).pop() ?? '');
    log('resize', { rendererCols: stats.cols, rendererRows: stats.rows, sttyRows: Number(stty?.[1]), sttyCols: Number(stty?.[2]), match: Number(stty?.[1]) === stats.rows && Number(stty?.[2]) === stats.cols });

    const FLOOD = 5_000_000;
    const before = text(id).length;
    const t0 = Date.now();
    manager.input(id, `head -c ${FLOOD} /dev/zero | tr '\\0' a; printf '\\nflood-done-%s\\n' ${nonce}\r`);
    await until('flood to finish', () => text(id).includes(`flood-done-${nonce}`), 120_000);
    const flood = text(id).slice(before);
    const longestRun = Math.max(...(flood.match(/a+/g) ?? ['']).map((s) => s.length));
    const fs = manager.stats(id);
    log('flood', { bytes: FLOOD, longestRunOfA: longestRun, complete: longestRun === FLOOD, ms: Date.now() - t0, pauses: fs?.pauseCount });
    // Every character sent must eventually be acknowledged, or flow control could stall the shell.
    await until('acks to drain', () => manager.stats(id)?.inFlight === 0, 5000);
    log('acks-drained', { inFlight: manager.stats(id)?.inFlight, paused: manager.stats(id)?.paused });

    manager.input(id, 'exit 3\r');
    const code = await until('shell exit', () => (tap.exits.has(id) ? { code: tap.exits.get(id)! } : undefined), 5000);
    log('exit', { exitCode: code.code, expected: 3 });

    // A second shell, then close the window: no shell may outlive it. The outer harness checks the pids.
    const second = manager.spawn();
    log('pids-before-close', { pids: [first.pid, second.pid] });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/**
 * Renders a colourful command and saves what the renderer drew. capturePage()
 * reads our own renderer, so it works while the window is excluded from
 * compositor capture — and it contains only this window.
 */
export async function uiSnapshotAutotest(win: BrowserWindow, manager: PtyManager, tap: TerminalTap, outPath: string, controller: ProtectionController): Promise<void> {
  try {
    const first = await until('renderer to spawn a shell', () => tap.spawned[0], 10_000);
    await sleep(500);
    manager.input(
      first.sessionId,
      "clear; printf '\\e[1mbold\\e[0m \\e[31mred\\e[0m \\e[32mgreen\\e[0m \\e[38;2;255;128;0mtruecolor-orange\\e[0m \\e[7mreverse\\e[0m\\n'; ls --color=always / | head -8; echo 'box: ┌─┐ │é│ └─┘  wide: 日本'\r",
    );
    await sleep(1500);
    const img = await win.webContents.capturePage();
    await writeFile(outPath, img.toPNG());
    log('snapshot', { path: outPath, size: img.getSize() });

    // The gate: with protection removed, real keystrokes must not reach the shell.
    const typeText = async (t: string) => {
      for (const ch of t) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await sleep(800);
    };
    const nonce = randomBytes(3).toString('hex');
    const seen = (marker: string) => (tap.output.get(first.sessionId) ?? []).join('').includes(marker);
    win.focus();
    await controller.unprotect();
    await sleep(300);
    await typeText(`echo gated-${nonce}`);
    const gatedSnap = outPath.replace(/\.png$/, '-gated.png');
    await writeFile(gatedSnap, (await win.webContents.capturePage()).toPNG());
    log('gate-while-unprotected', { level: controller.get().level, keystrokesReachedShell: seen(`gated-${nonce}`), snapshot: gatedSnap });
    await controller.protect();
    await sleep(300);
    await typeText(`echo open-${nonce}`);
    log('gate-after-protect', { level: controller.get().level, keystrokesReachedShell: seen(`open-${nonce}`) });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}
