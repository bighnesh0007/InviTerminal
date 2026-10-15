import { app, type BrowserWindow, clipboard } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PALETTE, randomSequence, type CanarySequence } from '../shared/canary';
import { findCanary } from '../shared/detect-canary';
import { contentMayShow } from '../shared/protection';
import type { ProtectionController } from './capture/ProtectionController';
import { spectacleFind, type SelfTestRunner } from './capture/selftest/SelfTestRunner';
import type { PtyManager } from './terminal/PtyManager';
import type { VisibilityWiring } from './visibility/register';
import * as kwin from './capture/kwin/dbus';
import type { LibraryService } from './library/LibraryService';

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
  spawned: { sessionId: string; pid: number; profileId: string }[];
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

/** Shell-printed canary: truecolour background blocks, so the "sensitive content" is real terminal output. */
function terminalCanaryCommand(seq: CanarySequence): string {
  const row = seq.map((c) => `\\033[48;2;${PALETTE[c]!.join(';')}m    `).join('') + '\\033[0m\\n';
  return `clear; printf '${row.repeat(6)}'\r`;
}

function findInBitmap(img: Electron.NativeImage, seq: CanarySequence): boolean {
  const { width, height } = img.getSize();
  const data = img.toBitmap();
  return (['bgra', 'rgba'] as const).some((order) => findCanary({ data, width, height, order }, seq).found);
}

/**
 * Phase 3: CLI toggle via a real second process, tray activation over D-Bus,
 * Ctrl+Shift+H, and the show-to-reapply gap measured with Spectacle.
 */
export async function visibilityAutotest(
  win: BrowserWindow,
  manager: PtyManager,
  tap: TerminalTap,
  controller: ProtectionController,
  visibility: VisibilityWiring,
  runner: SelfTestRunner,
  childEnv: Record<string, string>,
): Promise<void> {
  const waitVisible = (want: boolean, ms = 4000) => until(`window ${want ? 'shown' : 'hidden'}`, () => win.isVisible() === want || undefined, ms);
  const confirmed = () => contentMayShow(controller.get().level);
  try {
    const first = await until('renderer to spawn a shell', () => tap.spawned[0], 10_000);
    await until('protection confirmed', () => confirmed() || undefined, 10_000);

    // --- CLI through a real second instance -------------------------------------------
    const cli = (flag: string) =>
      new Promise<number>((res) => {
        const t0 = Date.now();
        // Same data dir as this instance, or the child takes a different single-instance lock and starts its own app.
        const env = { ...childEnv, INVI_USER_DATA_DIR: app.getPath('userData') };
        execFile(process.execPath, [app.getAppPath(), flag], { env, timeout: 15_000 }, () => res(Date.now() - t0));
      });
    for (const [flag, want] of [['--toggle', false], ['--toggle', true], ['--hide', false], ['--show', true]] as const) {
      const t0 = Date.now();
      const procMs = await cli(flag);
      await waitVisible(want);
      log('cli', { flag, visibleAfter: win.isVisible(), expected: want, ms: Date.now() - t0, secondInstanceMs: procMs });
    }
    await sleep(600);
    log('focus-after-cli-show', { focused: win.isFocused() });
    await until('protection re-confirmed', () => confirmed() || undefined, 10_000);

    // --- Tray activation via StatusNotifierItem D-Bus (what the Plasma panel calls) ------
    const items = await new Promise<string>((res) =>
      execFile('gdbus', ['call', '--session', '--dest', 'org.kde.StatusNotifierWatcher', '--object-path', '/StatusNotifierWatcher', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'], (_e, out) => res(out)),
    );
    const ours = [...items.matchAll(/'([^']+)'/g)].map((m) => m[1]!).find((i) => i.includes(`-${process.pid}-`));
    log('tray-registered', { item: ours ?? null });
    if (ours) {
      const slash = ours.indexOf('/');
      const [service, objPath] = [ours.slice(0, slash), ours.slice(slash)];
      await new Promise<void>((res) => execFile('gdbus', ['call', '--session', '--dest', service, '--object-path', objPath, '--method', 'org.kde.StatusNotifierItem.Activate', '0', '0'], () => res()));
      await waitVisible(false).catch(() => undefined);
      log('tray-activate', { visibleAfter: win.isVisible(), expected: false });
      await visibility.controller.show();
      await until('protection re-confirmed', () => confirmed() || undefined, 10_000);
    }

    // --- Ctrl+Shift+H ---------------------------------------------------------------------
    win.focus();
    await sleep(300);
    const tKey = Date.now();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H', modifiers: ['control', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H', modifiers: ['control', 'shift'] });
    await waitVisible(false).catch(() => undefined);
    log('panic-key', { visibleAfter: win.isVisible(), expected: false, ms: Date.now() - tKey });
    await visibility.controller.show();
    await until('protection re-confirmed', () => confirmed() || undefined, 10_000);
    await sleep(500);

    // --- The show → re-apply gap ------------------------------------------------------------
    const termSeq = randomSequence();
    manager.input(first.sessionId, terminalCanaryCommand(termSeq));
    await sleep(1000);
    // Proves the shell-printed canary is detectable at all (renderer-side capture, sees the real pixels).
    log('terminal-canary-detectable', { found: findInBitmap(await win.webContents.capturePage(), termSeq) });

    await runner.withControlWindow(async (controlSeq) => {
      win.focus();
      await sleep(300);
      const hidden = await visibility.controller.hide('cli');
      log('gap-hide', { concealedBeforeHide: hidden.concealed, ms: hidden.ms });
      await sleep(600);

      const tShow = Date.now();
      let confirmedAt: number | null = null;
      const poll = setInterval(() => {
        if (confirmedAt === null && confirmed() && controller.get().appliedAt && Date.parse(controller.get().appliedAt!) >= tShow) confirmedAt = Date.now() - tShow;
      }, 5);
      // Independent of the controller: when does KWin first know the new window, and when does its flag first read true?
      const kwinSeen: { firstSeenMs: number | null; firstSeenExcluded: boolean | null; excludedAtMs: number | null } = { firstSeenMs: null, firstSeenExcluded: null, excludedAtMs: null };
      const kwinPoll = (async () => {
        while (Date.now() - tShow < 1500 && kwinSeen.excludedAtMs === null) {
          try {
            for (const uuid of await kwin.matchWindowUuids(win.getTitle())) {
              const info = await kwin.getWindowInfo(uuid);
              if (!info || info.pid !== process.pid || info.caption !== win.getTitle()) continue;
              const ms = Date.now() - tShow;
              if (kwinSeen.firstSeenMs === null) Object.assign(kwinSeen, { firstSeenMs: ms, firstSeenExcluded: info.excludeFromCapture ?? null });
              if (info.excludeFromCapture === true) kwinSeen.excludedAtMs = ms;
            }
          } catch {
            // window not mapped yet
          }
        }
      })();
      void visibility.controller.show();
      // Renderer-side view immediately after show: must be the cover, not the terminal.
      const early = await win.webContents.capturePage();
      const earlyMs = Date.now() - tShow;
      const captures: object[] = [];
      while (Date.now() - tShow < 2500) {
        const startMs = Date.now() - tShow;
        const r = await spectacleFind({ protectedSeq: termSeq, controlSeq });
        captures.push({ startMs, endMs: Date.now() - tShow, terminalCanaryFound: r.protectedFound, controlFound: r.controlFound });
      }
      clearInterval(poll);
      await kwinPoll;
      log('gap-kwin', kwinSeen);
      log('gap', {
        rendererShowsTerminalAtMs: earlyMs,
        rendererShowsTerminal: findInBitmap(early, termSeq),
        protectionConfirmedAfterShowMs: confirmedAt,
        captures,
      });
    });
    await sleep(300);
    log('terminal-restored-after-reconfirm', { found: findInBitmap(await win.webContents.capturePage(), termSeq), level: controller.get().level });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

export interface ShortcutStatus {
  accelerator: string | null;
  registerReturned: boolean | null;
  firedCount: number;
}

/**
 * Needs a person: accept KDE's shortcut dialog, then press the shortcut twice
 * (hide, then show). Passes only if the key actually fires and toggles.
 */
export async function portalShortcutAutotest(win: BrowserWindow, s: ShortcutStatus): Promise<void> {
  log('registered', { accelerator: s.accelerator, registerReturned: s.registerReturned });
  if (!s.accelerator) {
    log('error', { message: 'INVI_GLOBAL_SHORTCUT is not set' });
    win.close();
    return;
  }
  const t0 = Date.now();
  try {
    await until('first key press', () => s.firedCount >= 1 || undefined, 180_000);
    await sleep(500);
    log('fired-1', { afterMs: Date.now() - t0, visibleAfter: win.isVisible(), expected: false });
    await until('second key press', () => s.firedCount >= 2 || undefined, 120_000);
    await sleep(800);
    log('fired-2', { afterMs: Date.now() - t0, visibleAfter: win.isVisible(), expected: true, focused: win.isFocused() });
  } catch (e) {
    log('error', { message: (e as Error).message, firedCount: s.firedCount });
  }
  win.close();
}

/** Strips CSI/OSC escapes so terminal output can be checked line by line. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[=>]/g, '');
}

/** True if `marker` appeared as a whole output line — i.e. a command printed it, not just the typed command line. */
function printedLine(output: string, marker: string): boolean {
  return stripAnsi(output)
    .split(/[\r\n]+/)
    .some((line) => line.trim() === marker);
}

/**
 * Phase 4: the snippet library through the real renderer, against a throwaway
 * mongod. Records what reaches the PTY to prove inserting never executes.
 */
export async function libraryAutotest(
  win: BrowserWindow,
  manager: PtyManager,
  tap: TerminalTap,
  controller: ProtectionController,
  library: LibraryService,
  inputs: Map<string, string[]>,
  snapshotPath: string | undefined,
): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const nonce = randomBytes(3).toString('hex');
  // The test overwrites the clipboard; every format on it is saved and put back afterwards.
  const savedClipboard = await clipboard.read().catch(() => null);
  try {
    const first = await until('renderer to spawn a shell', () => tap.spawned[0], 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);
    await until('library ready', () => library.getStatus().state === 'ready' || undefined, 10_000);
    const id = first.sessionId;
    const typed = () => (inputs.get(id) ?? []).join('');
    const out = () => (tap.output.get(id) ?? []).join('');

    const store = library.require();
    const single = await store.create({ title: `single ${nonce}`, body: `echo invi-single-${nonce}\n`, folder: 'autotest', tags: ['demo'] });
    const multi = await store.create({ title: `multi ${nonce}`, body: `echo invi-ml1-${nonce}\necho invi-ml2-${nonce}\n`, folder: 'autotest/deep' });
    await store.create({ title: 'unrelated', body: 'uptime' });

    await clickIn('header', 'Snippets');
    await js(`(() => { const s = document.querySelector('.lib-search'); s.value = ${JSON.stringify(nonce)}; s.dispatchEvent(new Event('input')); })()`);
    await sleep(600);
    const listed = await js<string[]>(`[...document.querySelectorAll('.lib-item .lib-title')].map((e) => e.textContent)`);
    log('search', { query: nonce, listed, expected: [`multi ${nonce}`, `single ${nonce}`].sort() });

    // Single-line insert: typed into the shell, but never executed.
    const before = typed().length;
    await clickIn(`[data-snippet-id="${single.id}"]`, 'Insert');
    await sleep(800);
    const sent = typed().slice(before);
    log('insert-single', {
      reachedPty: sent.includes(`echo invi-single-${nonce}`),
      containsNewline: /[\r\n]/.test(sent),
      executed: printedLine(out(), `invi-single-${nonce}`),
      useCount: (await store.get(single.id))?.useCount,
    });
    manager.input(id, '\r');
    // Positive control for the check above: the same detector must see it once Enter is pressed.
    await until('manual Enter runs it', () => printedLine(out(), `invi-single-${nonce}`) || undefined, 5000);
    log('enter-runs-it', { executed: true });

    // Multi-line: confirmation first; Cancel writes nothing; confirming pastes (bracketed) without running.
    const beforeMulti = typed().length;
    await clickIn(`[data-snippet-id="${multi.id}"]`, 'Insert');
    await sleep(300);
    const confirmShown = await js<boolean>(`!document.querySelector('.lib-confirm').hidden`);
    const writtenBeforeConfirm = typed().length - beforeMulti;
    await clickIn('.lib-confirm', 'Cancel');
    await sleep(300);
    const writtenAfterCancel = typed().length - beforeMulti;
    await clickIn(`[data-snippet-id="${multi.id}"]`, 'Insert');
    await sleep(300);
    await clickIn('.lib-confirm', 'Insert');
    await sleep(800);
    const ml = typed().slice(beforeMulti);
    log('insert-multi', {
      confirmShown,
      writtenBeforeConfirm,
      writtenAfterCancel,
      bracketed: ml.startsWith('\x1b[200~') && ml.endsWith('\x1b[201~'),
      endsWithNewline: /[\r\n]$/.test(ml.replace(/\x1b\[201~$/, '')),
      executed: printedLine(out(), `invi-ml1-${nonce}`) || printedLine(out(), `invi-ml2-${nonce}`),
    });
    // Positive control: Enter runs the pasted lines, and the detector sees both.
    manager.input(id, '\r');
    await until('Enter runs the multi-line paste', () => (printedLine(out(), `invi-ml1-${nonce}`) && printedLine(out(), `invi-ml2-${nonce}`)) || undefined, 5000);
    log('enter-runs-multi', { executed: true });

    // Copy puts the body on the clipboard (restored at the end).
    await clickIn(`[data-snippet-id="${single.id}"]`, 'Copy');
    await sleep(300);
    log('copy', { clipboardMatches: (await clipboard.readText()) === single.body });

    // Edit through the form.
    await clickIn(`[data-snippet-id="${single.id}"]`, 'Edit');
    await js(`(() => { const t = document.querySelector('.lib-editor input'); t.value = 'renamed ${nonce}'; })()`);
    await clickIn('.lib-editor', 'Save');
    await sleep(500);
    log('edit', { stored: (await store.get(single.id))?.title, expected: `renamed ${nonce}` });

    // Delete → Undo.
    await clickIn(`[data-snippet-id="${multi.id}"]`, 'Delete');
    await sleep(400);
    const trashed = (await store.get(multi.id))?.deletedAt !== null;
    await clickIn('.lib-message', 'Undo');
    await sleep(400);
    log('delete-undo', { trashed, restored: (await store.get(multi.id))?.deletedAt === null });

    if (snapshotPath) {
      await writeFile(snapshotPath, (await win.webContents.capturePage()).toPNG());
      log('snapshot', { path: snapshotPath });
    }

    // The library is behind the protection gate too.
    await controller.unprotect();
    await sleep(400);
    const hidden = await js<string>(`getComputedStyle(document.querySelector('.library')).visibility`);
    const gateShown = await js<boolean>(`!document.querySelector('.gate').hidden`);
    log('gated', { libraryVisibility: hidden, gateShown });
    await controller.protect();
  } catch (e) {
    log('error', { message: (e as Error).message });
  } finally {
    if (savedClipboard) await clipboard.write(savedClipboard).catch(() => undefined);
  }
  win.close();
}

type Mod = 'control' | 'shift' | 'alt' | 'meta';

function press(win: BrowserWindow, keyCode: string, modifiers: Mod[] = []): void {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function typeLine(win: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await sleep(700);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Phase 5: tabs driven by real keystrokes, and settings edited through the UI (temp data dir). */
export async function tabsSettingsAutotest(win: BrowserWindow, tap: TerminalTap, controller: ProtectionController, settingsFile: string): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const nonce = randomBytes(3).toString('hex');
  const out = (i: number) => (tap.output.get(tap.spawned[i]?.sessionId ?? '') ?? []).join('');
  try {
    await until('first shell', () => tap.spawned[0], 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);
    win.focus();
    await sleep(500);

    press(win, 'T', ['control', 'shift']);
    await until('tab 2', () => tap.spawned[1], 5000);
    press(win, 'T', ['control', 'shift']);
    await until('tab 3', () => tap.spawned[2], 5000);
    await sleep(800);
    log('tabs-opened', { count: tap.spawned.length, distinctPids: new Set(tap.spawned.map((s) => s.pid)).size, profiles: tap.spawned.map((s) => s.profileId) });

    await typeLine(win, `echo tab3-${nonce}`);
    log('typing-goes-to-active-tab', { inTab3: printedLine(out(2), `tab3-${nonce}`), inTab1: printedLine(out(0), `tab3-${nonce}`), inTab2: printedLine(out(1), `tab3-${nonce}`) });

    press(win, 'PageUp', ['control']);
    await sleep(500);
    await typeLine(win, `echo tab2-${nonce}`);
    log('prev-tab', { inTab2: printedLine(out(1), `tab2-${nonce}`), inTab3: printedLine(out(2), `tab2-${nonce}`) });

    const tab2Pid = tap.spawned[1]!.pid;
    press(win, 'W', ['control', 'shift']);
    await until('tab 2 shell gone', () => !alive(tab2Pid) || undefined, 4000).catch(() => undefined);
    const tabsLeft = await js<number>(`document.querySelectorAll('.tab').length`);
    await sleep(400);
    await typeLine(win, `echo after-close-${nonce}`);
    log('close-tab', { closedShellGone: !alive(tab2Pid), tabsLeft, typingNowInTab3: printedLine(out(2), `after-close-${nonce}`) });

    // --- settings through the UI ---------------------------------------------------------
    press(win, ',', ['control', 'shift']);
    await sleep(600);
    const panelOpen = await js<boolean>(`!document.querySelector('.settings').hidden`);
    await js(`(() => {
      const panel = document.querySelector('.settings');
      const num = panel.querySelectorAll('input[type=number]');
      num[0].value = '18';
      const sel = panel.querySelector('select');
      sel.value = 'sh';
      panel.querySelector('.chord-input[data-action=newTab]').focus();
    })()`);
    press(win, 'N', ['control', 'alt']);
    await sleep(200);
    const recorded = await js<string>(`document.querySelector('.chord-input[data-action=newTab]').value`);
    await js(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent === 'Save').click()`);
    await sleep(800);
    const saved = JSON.parse(await readFile(settingsFile, 'utf8')) as { terminal: { fontSize: number; defaultProfile: string }; shortcuts: { newTab: string } };
    const fontPx = await js<string>(`getComputedStyle(document.querySelector('.tab-host:not([hidden]) .xterm-rows')).fontSize`);
    log('settings-saved', { panelOpen, recordedChord: recorded, file: { fontSize: saved.terminal.fontSize, defaultProfile: saved.terminal.defaultProfile, newTab: saved.shortcuts.newTab }, xtermFontSize: fontPx });

    // Close the panel, then: the old chord is dead, the new one opens a tab with the new default shell.
    press(win, ',', ['control', 'shift']);
    await sleep(300);
    const focusedBefore = await js<string>(`document.activeElement ? document.activeElement.className + ' ' + document.activeElement.tagName : 'none'`);
    const before = tap.spawned.length;
    press(win, 'T', ['control', 'shift']);
    await sleep(900);
    const oldChordOpened = tap.spawned.length > before;
    press(win, 'N', ['control', 'alt']);
    await until('tab from new chord', () => tap.spawned.length > before || undefined, 4000).catch(() => undefined);
    log('rebound-shortcut', { focusedBefore, oldChordOpenedTab: oldChordOpened, newChordOpenedTab: tap.spawned.length > before, newTabProfile: tap.spawned[tap.spawned.length - 1]?.profileId });

    // Invalid shortcuts: the panel refuses, and so does main when the panel is bypassed.
    const fileBefore = await readFile(settingsFile, 'utf8');
    press(win, ',', ['control', 'shift']);
    await sleep(500);
    await js(`document.querySelector('.chord-input[data-action=panicHide]').focus()`);
    press(win, 'C', ['control']);
    await sleep(200);
    const fieldError = await js<string>(`document.querySelector('.chord-input[data-action=panicHide]').parentElement.querySelector('.field-error').textContent`);
    await js(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent === 'Save').click()`);
    await sleep(400);
    const panelMessage = await js<string>(`document.querySelector('.settings .lib-message').textContent`);
    const mainRejects = await js<string>(`window.inviterminal.settings.update({ shortcuts: { panicHide: 'Ctrl+C' } }).then(() => 'ACCEPTED', (e) => String(e.message))`);
    const smuggle = await js<string>(`window.inviterminal.settings.update({ terminal: { fontSize: 14 }, evil: true }).then(() => 'ACCEPTED', (e) => String(e.message).slice(0, 80))`);
    log('invalid-refused', { fieldError, panelMessage, mainRejects: mainRejects.slice(0, 160), smuggledKey: smuggle, fileUnchanged: (await readFile(settingsFile, 'utf8')) === fileBefore });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Second launch on the same data dir: settings must have persisted. */
export async function settingsReadbackAutotest(win: BrowserWindow, tap: TerminalTap, view: () => unknown): Promise<void> {
  try {
    const first = await until('first shell', () => tap.spawned[0], 10_000);
    log('readback', { firstTabProfile: first.profileId, view: view() });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 7a: API key round-trip through the real renderer + Electron safeStorage. No network. */
export async function aiKeyAutotest(win: BrowserWindow, settingsFile: string, userDataDir: string): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const keyFile = join(userDataDir, 'ai-key.enc');
  const FAKE = 'gsk_fakeKeyForAutotest0123456789abcdef';
  try {
    const { safeStorage } = await import('electron');
    log('safeStorage', { encryptionAvailable: safeStorage.isEncryptionAvailable() });
    await until('renderer ready', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);

    const before = await js<{ source: string; present: boolean }>('window.inviterminal.ai.status().then(s => s.key)');
    const setErr = await js<string | null>(`window.inviterminal.ai.setKey(${JSON.stringify(FAKE)})`);
    await sleep(300);
    const after = await js<{ source: string; present: boolean; hint: string | null }>('window.inviterminal.ai.status().then(s => s.key)');
    const fileRaw = await readFile(keyFile).then((b) => b.toString('latin1')).catch(() => '');
    const settingsRaw = await readFile(settingsFile, 'utf8').catch(() => '');
    log('set-key', {
      before,
      setError: setErr,
      after,
      fileEncryptedNotPlaintext: fileRaw.length > 0 && !fileRaw.includes(FAKE),
      fileMode: (await stat(keyFile)).mode & 0o777,
      keyAbsentFromSettings: !settingsRaw.includes(FAKE),
      hintMasksKey: after.hint !== null && !after.hint.includes(FAKE),
    });

    const cleared = await js<string | null>('window.inviterminal.ai.clearKey().then(() => null, (e) => String(e))');
    await sleep(200);
    const end = await js<{ present: boolean }>('window.inviterminal.ai.status().then(s => s.key)');
    const fileGone = await readFile(keyFile).then(() => false, () => true);
    log('clear-key', { clearError: cleared, presentAfterClear: end.present, fileRemoved: fileGone });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 7b: the explain flow through the real renderer with the stub model (no network, no key). */
export async function aiExplainAutotest(win: BrowserWindow, manager: PtyManager, tap: TerminalTap, controller: ProtectionController): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const canary = `gsk_autotest${randomBytes(10).toString('hex')}`;
  try {
    const first = await until('shell', () => tap.spawned[0], 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);
    win.focus();
    await sleep(400);

    // No key yet: Explain should say so and send nothing.
    await clickIn('header', 'Explain');
    await sleep(300);
    const noKeyMsg = await js<string>(`document.querySelector('.ai-panel .lib-message').textContent`);
    log('no-key', { message: noKeyMsg, confirmShown: await js<boolean>(`!document.querySelector('.ai-confirm').hidden`) });
    await clickIn('.ai-panel', 'Close');

    // Set a fake key so the panel will offer to send (the stub never calls the network).
    await js(`window.inviterminal.ai.setKey('gsk_fakeExplainAutotest0123456789abcd')`);
    await sleep(300);

    // Put a secret-looking line on screen (used via the viewport fallback — no selection).
    manager.input(first.sessionId, `printf '%s\\n' ${canary}\r`);
    await until('canary on screen', () => (tap.output.get(first.sessionId) ?? []).join('').includes(canary) || undefined, 5000);
    await sleep(300);

    await clickIn('header', 'Explain');
    await sleep(400);
    const beforeSend = {
      confirmShown: await js<boolean>(`!document.querySelector('.ai-confirm').hidden`),
      previewHasCanary: await js<boolean>(`document.querySelector('.ai-preview').textContent.includes(${JSON.stringify(canary)})`),
      outputEmpty: await js<string>(`document.querySelector('.ai-output').textContent`).then((t) => t === ''),
      summary: await js<string>(`document.querySelector('.ai-confirm .field-note').textContent`),
    };
    log('confirm', beforeSend);

    // Toggle redaction off → the preview reveals the canary (proves the toggle works), then back on.
    const previewAfterToggle = await js<boolean>(`(() => { const cb = document.querySelector('.ai-confirm input[type=checkbox]'); cb.checked = false; cb.dispatchEvent(new Event('change')); return document.querySelector('.ai-preview').textContent.includes(${JSON.stringify(canary)}); })()`);
    await js(`(() => { const cb = document.querySelector('.ai-confirm input[type=checkbox]'); cb.checked = true; cb.dispatchEvent(new Event('change')); })()`);
    log('redact-toggle', { withRedactOff_previewHasCanary: previewAfterToggle });

    // Send (redaction on). The stub logs whether main handed it the canary.
    await clickIn('.ai-confirm', 'Send to Groq');
    await until('stream done', () => js<string>(`document.querySelector('.ai-panel .lib-message').textContent`).then((t) => t === 'Done.' || t.startsWith('Error')), 10_000);
    const out = await js<string>(`document.querySelector('.ai-output').textContent`);
    log('sent-redacted', { outputHasStub: out.includes('[stub'), outputHasCanary: out.includes(canary) });
    await sleep(400);
    if (process.env.INVI_SNAPSHOT_PATH) {
      await writeFile(process.env.INVI_SNAPSHOT_PATH, (await win.webContents.capturePage()).toPNG());
      log('snapshot', { path: process.env.INVI_SNAPSHOT_PATH });
    }
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 7c: the microphone permission gate and recording indicator. Drives real getUserMedia. */
export async function micGateAutotest(win: BrowserWindow, audio: { micAllowed: boolean }): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  // Returns {ok, tracks} or {ok:false, name}. Always stops tracks so the mic never stays on.
  const gum = (c: string) =>
    js<{ ok: boolean; tracks?: number; name?: string }>(
      `navigator.mediaDevices.getUserMedia(${c}).then(s => { const n = s.getTracks().length; s.getTracks().forEach(t => t.stop()); return { ok: true, tracks: n }; }, e => ({ ok: false, name: e.name }))`,
    );
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);

    // 1) Mic denied before any session.
    const beforeAudio = await gum('{ audio: true }');
    const beforeVideo = await gum('{ video: true }');
    log('before-session', { micAllowedMain: audio.micAllowed, audio: beforeAudio, video: beforeVideo });

    // 2) Start a session → mic allowed; video still denied.
    const startErr = await js<string | null>(`window.inviterminal.audio.start('mic-test')`);
    await sleep(200);
    const duringAudio = await gum('{ audio: true }');
    const duringVideo = await gum('{ video: true }');
    const st = await js<{ active: boolean; kind: string | null }>(`window.inviterminal.audio.status()`);
    const badgeShown = await js<boolean>(`!document.querySelector('.rec-badge').hidden`);
    const badgeText = await js<string>(`document.querySelector('.rec-badge').textContent`);
    log('during-session', { startError: startErr, micAllowedMain: audio.micAllowed, status: st, audio: duringAudio, videoStillDenied: duringVideo, badgeShown, badgeText });
    if (process.env.INVI_SNAPSHOT_PATH) {
      await writeFile(process.env.INVI_SNAPSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    }
    // The tray indicator must survive a panic-hide (recording is never silently hidden).
    const ours = await new Promise<string>((res) => execFile('gdbus', ['call', '--session', '--dest', 'org.kde.StatusNotifierWatcher', '--object-path', '/StatusNotifierWatcher', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'], (_e, out) => res(out || '')));
    const item = [...ours.matchAll(/'([^']+)'/g)].map((m) => m[1]!).find((i) => i.includes(`-${process.pid}-`));
    let tooltip = '';
    if (item) {
      const slash = item.indexOf('/');
      tooltip = await new Promise<string>((res) => execFile('gdbus', ['call', '--session', '--dest', item.slice(0, slash), '--object-path', item.slice(slash), '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierItem', 'ToolTip'], (_e, out) => res(out || '')));
    }
    win.hide();
    await sleep(400);
    log('during-hide', { stillRecording: audio.micAllowed, trayTooltipMentionsRecording: /recording/i.test(tooltip), trayTooltip: tooltip.replace(/\s+/g, ' ').slice(0, 120) });
    win.show();
    await sleep(200);

    // 3) Stop → mic denied again, badge gone.
    await js(`window.inviterminal.audio.stop()`);
    await sleep(200);
    const afterAudio = await gum('{ audio: true }');
    const badgeAfter = await js<boolean>(`!document.querySelector('.rec-badge').hidden`);
    log('after-stop', { micAllowedMain: audio.micAllowed, audio: afterAudio, badgeShown: badgeAfter });

    // 4) Meeting recording needs consent first.
    const meetingNoConsent = await js<string | null>(`window.inviterminal.audio.start('meeting')`);
    await js(`window.inviterminal.audio.consentToMeeting()`);
    const meetingWithConsent = await js<string | null>(`window.inviterminal.audio.start('meeting')`);
    await js(`window.inviterminal.audio.stop()`);
    log('meeting-consent', { withoutConsent: meetingNoConsent, withConsent: meetingWithConsent });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 7d: local STT through the renderer IPC. Uses a known sample so the transcript is deterministic. */
export async function sttAutotest(win: BrowserWindow): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);
    const st = await js<{ available: boolean; model: string; reason: string | null }>(`window.inviterminal.stt.status()`);
    log('stt-status', st);

    const samplePath = process.env.INVI_STT_SAMPLE;
    if (!samplePath) {
      log('error', { message: 'INVI_STT_SAMPLE not set' });
      win.close();
      return;
    }
    const b64 = (await readFile(samplePath)).toString('base64');
    const beforeDirs = (await readdir(tmpdir())).filter((d) => d.startsWith('inviterminal-stt-')).length;
    const r = await js<{ text: string; ms: number }>(
      `(async () => { const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return window.inviterminal.stt.transcribe(u8); })()`,
    );
    const afterDirs = (await readdir(tmpdir())).filter((d) => d.startsWith('inviterminal-stt-')).length;
    log('transcribe', { text: r.text.slice(0, 120), containsExpected: /ask not what your country/i.test(r.text), ms: r.ms, tempDirsLeaked: afterDirs - beforeDirs });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/**
 * Phase 7f: the interviewer reads questions aloud. Drives the real renderer with the stub
 * interviewer and a FAKE speech engine (so no audio plays); `spoken` holds the text the engine
 * was handed, so the renderer → main → engine chain is observable. Positive control: with the
 * toggle on, the finished question is spoken. Negative control: with it off, nothing is spoken —
 * so a pass can't come from the instrument always saying "spoken".
 */
export async function ttsAutotest(win: BrowserWindow, controller: ProtectionController, spoken: string[]): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const bubbles = () => js<{ who: string; text: string }[]>(`[...document.querySelectorAll('.practice-convo .bubble')].map(b => ({ who: b.querySelector('.bubble-who').textContent, text: b.querySelector('.bubble-text').textContent }))`);
  const waitFor = async (pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleep(80);
    }
    return false;
  };
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);

    const st = await js<{ available: boolean; binary: string; voice: string | null; reason: string | null }>(`window.inviterminal.tts.status()`);
    log('tts-status', st);

    // Direct IPC round-trip: speak resolves and the engine received the text.
    await js(`window.inviterminal.tts.speak('direct speech test')`);
    log('direct-speak', { reached: spoken.some((s) => s === 'direct speech test') });

    await js(`window.inviterminal.ai.setKey('gsk_fakeTtsAutotest0123456789abcdef')`);
    await sleep(300);
    await clickIn('header', 'Practice');
    await sleep(200);

    const toggleVisibleAndOff = await js<{ present: boolean; hidden: boolean; checked: boolean }>(
      `(() => { const c = document.querySelector('.practice-tts input'); const l = document.querySelector('.practice-tts'); return { present: !!c, hidden: !l || l.hidden, checked: !!(c && c.checked) }; })()`,
    );
    log('toggle-default', toggleVisibleAndOff); // present, not hidden (engine available), unchecked (off by default)

    // Positive control: turn Read aloud ON, start the interview, expect the question spoken.
    await js(`document.querySelector('.practice-tts input').click()`);
    await js(`(() => { const t = document.querySelector('.practice-panel input'); t.value = 'system design'; })()`);
    await clickIn('.practice-panel .lib-field', 'Start interview');
    await waitFor(async () => (await bubbles()).some((b) => b.who === 'Interviewer' && /Question 1/.test(b.text)));
    const spokeQuestion = await waitFor(async () => spoken.some((s) => /Question 1/.test(s)));
    log('positive-control', { spokeQuestion, lastSpoken: spoken.at(-1)?.slice(0, 60) });

    // Negative control: turn Read aloud OFF; the next interviewer turn must NOT be spoken.
    await js(`document.querySelector('.practice-tts input').click()`);
    const spokenBefore = spoken.length;
    await js(`(() => { const a = document.querySelector('.practice-answer textarea'); a.value = 'I would clarify requirements and estimate scale.'; })()`);
    await clickIn('.practice-answer', 'Send answer');
    await waitFor(async () => (await bubbles()).filter((b) => b.who === 'Interviewer').length >= 2);
    await sleep(300); // give any (erroneous) speak call time to land
    log('negative-control', { speakCallsAfterToggleOff: spoken.length - spokenBefore });

    await clickIn('.practice-panel', 'End');
    await sleep(150);
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/**
 * Phase 1 (live transcript): drives the real renderer with a FAKE capture (scripted zero chunks)
 * and a scripted transcriber, so the consent gate → capture → chunk → transcribe → line → panel
 * chain is observable without real audio or the whisper model. Also checks consent is required.
 */
export async function liveTranscriptAutotest(win: BrowserWindow, controller: ProtectionController): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const lines = () => js<string[]>(`[...document.querySelectorAll('.live-feed .live-line .live-text')].map(e => e.textContent)`);
  const waitFor = async (pred: () => Promise<boolean>, ms = 12_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);

    await clickIn('header', 'Live');
    await sleep(200);

    // Negative control: Start is disabled until consent is checked.
    const startDisabledNoConsent = await js<boolean>(`document.querySelector('.live-panel .lib-actions button').disabled`);
    log('consent-gate', { startDisabledWithoutConsent: startDisabledNoConsent });

    // Give consent and enable speaker-turn labels (the fake diarizer reports available).
    await js(`document.querySelectorAll('.live-consent input')[0].click()`); // consent
    await js(`document.querySelectorAll('.live-consent input')[1].click()`); // diarize
    await sleep(100);
    await clickIn('.live-panel .lib-actions', 'Start transcribing');

    const gotLines = await waitFor(async () => (await lines()).length >= 2);
    const seen = await lines();
    const speakers = await js<string[]>(`[...document.querySelectorAll('.live-feed .live-speaker')].map(e => e.textContent)`);
    log('transcribing', { gotLines, lineCount: seen.length, first: seen[0], speakers: speakers.slice(0, 3), badge: await js<string>(`document.querySelector('.live-badge').textContent`) });

    // Ask AI about the first line (needs a key; the stub streamer answers deterministically).
    await js(`window.inviterminal.ai.setKey('gsk_fakeLiveAskAutotest0123456789abc')`);
    await waitFor(async () => !(await js<boolean>(`document.querySelector('.live-item .live-ask').disabled`)));
    await js(`document.querySelector('.live-length button[data-len="short"]').click()`);
    await js(`document.querySelector('.live-item .live-ask').click()`);
    const gotAnswer = await waitFor(async () => /stub/.test(await js<string>(`document.querySelector('.live-item .live-answer').textContent || ''`)));
    log('ask-ai', { gotAnswer, answer: (await js<string>(`document.querySelector('.live-item .live-answer').textContent`)).slice(0, 60) });

    // Behind the gate: removing protection conceals the panel.
    await controller.unprotect();
    await sleep(300);
    log('gated', { visibility: await js<string>(`getComputedStyle(document.querySelector('.live-panel')).visibility`) });
    await controller.protect();

    await clickIn('.live-panel .lib-actions', 'Stop');
    await sleep(200);
    log('stopped', { badgeHidden: await js<boolean>(`document.querySelector('.live-badge').hidden`) });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 7e: the interview practice loop through the real renderer with the stub interviewer. */
export async function practiceAutotest(win: BrowserWindow, controller: ProtectionController): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const bubbles = () => js<{ who: string; text: string }[]>(`[...document.querySelectorAll('.practice-convo .bubble')].map(b => ({ who: b.querySelector('.bubble-who').textContent, text: b.querySelector('.bubble-text').textContent }))`);
  const waitFor = async (pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleep(80);
    }
    return false;
  };
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);
    await until('protection confirmed', () => contentMayShow(controller.get().level) || undefined, 10_000);

    await js(`window.inviterminal.ai.setKey('gsk_fakePracticeAutotest0123456789abc')`);
    await sleep(300);
    await clickIn('header', 'Practice');
    await sleep(200);

    await js(`(() => { const t = document.querySelector('.practice-panel input'); t.value = 'system design'; })()`);
    await clickIn('.practice-panel .lib-field', 'Start interview');
    await waitFor(async () => (await bubbles()).some((b) => b.who === 'Interviewer' && /Question 1/.test(b.text)));
    log('started', { bubbles: await bubbles() });

    // Type an answer and send → feedback + next question.
    await js(`(() => { const a = document.querySelector('.practice-answer textarea'); a.value = 'I would start by clarifying requirements and estimating scale.'; })()`);
    await clickIn('.practice-answer', 'Send answer');
    await waitFor(async () => (await bubbles()).filter((b) => b.who === 'Interviewer').length >= 2 && /Next question/.test((await bubbles()).at(-1)?.text ?? ''));
    const bs = await bubbles();
    log('answered', {
      youBubble: bs.find((b) => b.who === 'You')?.text.slice(0, 50),
      interviewerTurns: bs.filter((b) => b.who === 'Interviewer').length,
      lastHasNextQuestion: /Next question/.test(bs[bs.length - 1]?.text ?? ''),
    });

    if (process.env.INVI_SNAPSHOT_PATH) await writeFile(process.env.INVI_SNAPSHOT_PATH, (await win.webContents.capturePage()).toPNG());
    // Behind the gate: removing protection conceals the panel.
    await controller.unprotect();
    await sleep(300);
    const concealed = await js<string>(`getComputedStyle(document.querySelector('.practice-panel')).visibility`);
    log('gated', { visibility: concealed });
    await controller.protect();

    await clickIn('.practice-panel', 'End');
    await sleep(200);
    log('ended', { answerRowHidden: await js<boolean>(`document.querySelector('.practice-answer').hidden`) });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  win.close();
}

/** Phase 8b/8c: start sharing via the UI, pair a real WS client, and confirm an explanation is pushed. */
export async function companionAutotest(win: BrowserWindow, companion: { currentUrl(): string | null }): Promise<void> {
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const clickIn = (scope: string, text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const { WebSocket } = await import('ws');
  let ws: { close(): void } | null = null;
  const waitFor = async (pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleep(80);
    }
    return false;
  };
  try {
    await until('renderer', () => js<boolean>('!!window.inviterminal').catch(() => false), 10_000);
    await clickIn('header', 'Share');
    await sleep(200);
    await clickIn('.companion-panel', 'Start sharing');
    await waitFor(() => js<boolean>(`window.inviterminal.companion.status().then(s => s.running)`), 8000);
    const st = await js<{ running: boolean; host: string; port: number; clients: number; fingerprint: string; qrDataUrl: string }>(`window.inviterminal.companion.status()`);
    log('started', { running: st.running, host: st.host, port: st.port, qrIsPng: (st.qrDataUrl ?? '').startsWith('data:image/png'), fingerprintOk: /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(st.fingerprint) });

    const url = companion.currentUrl()!; // main-only; carries the token
    const token = url.split('#t=')[1]!;
    const wssUrl = `wss://${st.host}:${st.port}/`;
    const socket = new WebSocket(wssUrl, ['inviterminal', token], { rejectUnauthorized: false });
    ws = socket;
    const explanationGot = new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'explanation') resolve(m);
      });
    });
    await new Promise<void>((r) => socket.on('open', () => r()));
    await sleep(300);
    const afterPair = await js<number>(`window.inviterminal.companion.status().then(s => s.clients)`);
    log('paired', { clientsSeenByApp: afterPair });

    // Run an explanation (stub model) — its result should be pushed to the paired client.
    await js(`window.inviterminal.ai.setKey('gsk_fakeCompanionAutotest0123456789abc')`);
    await js(`window.inviterminal.ai.explain({ text: 'bash: foo: command not found', redact: true, wantImage: false })`);
    const msg = await Promise.race([explanationGot, sleep(8000).then(() => null)]);
    log('explanation-pushed', { received: msg !== null, title: msg?.title, textHasStub: typeof msg?.text === 'string' && (msg.text as string).includes('[stub') });
    if (process.env.INVI_SNAPSHOT_PATH) await writeFile(process.env.INVI_SNAPSHOT_PATH, (await win.webContents.capturePage()).toPNG());

    await clickIn('.companion-panel', 'Stop sharing');
    await waitFor(() => js<boolean>(`window.inviterminal.companion.status().then(s => !s.running)`), 5000);
    log('stopped', { running: await js<boolean>(`window.inviterminal.companion.status().then(s => s.running)`) });
  } catch (e) {
    log('error', { message: (e as Error).message });
  }
  ws?.close();
  win.close();
}
