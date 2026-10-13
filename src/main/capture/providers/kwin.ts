import type { BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as kwin from '../kwin/dbus';
import type { KwinWindowInfo } from '../kwin/gvariant';
import { buildExclusionScript } from '../kwin/script';
import type { CaptureExclusionProvider } from '../types';

const KNOWN_GAPS = [
  'KWin 6.7.5 filters whole-screen and region screencasts and screenshots. Its source does not filter a capture of this specific window ("share a window"); test that path before relying on it.',
  'KWin removes the window from the capture; whatever is behind it is shown instead.',
  'Protection is per window instance. Hiding and re-showing the window creates a new instance, so the app re-applies it; there is a short gap while it does.',
  'Not covered by any compositor setting: cameras pointed at the screen, accessibility APIs, the clipboard, and the window title shown in screen-share pickers.',
];

/**
 * Finds our window in KWin. WindowsRunner.Match is the only non-interactive
 * KWin D-Bus call that returns window uuids; it matches captions by
 * substring, so other apps can match too — the pid and exact caption filter
 * picks ours.
 */
async function findOwnWindow(win: BrowserWindow): Promise<KwinWindowInfo | null> {
  const title = win.getTitle();
  for (const uuid of await kwin.matchWindowUuids(title)) {
    const info = await kwin.getWindowInfo(uuid);
    if (info && info.pid === process.pid && info.caption === title) return info;
  }
  return null;
}

/** KWin learns about a newly shown window asynchronously; poll briefly. */
async function findOwnWindowWithRetry(win: BrowserWindow, timeoutMs = 2000): Promise<KwinWindowInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await findOwnWindow(win);
    if (info || Date.now() > deadline) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runOneShotScript(source: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inviterminal-kwin-'));
  const file = join(dir, 'exclude.js');
  const name = `inviterminal-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(file, source, { mode: 0o600 });
    const id = await kwin.loadScript(file, name);
    try {
      await kwin.runScript(id);
    } finally {
      await kwin.unloadScript(name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createKwinProvider(): CaptureExclusionProvider {
  return {
    id: 'kwin',

    async probe(win) {
      try {
        const info = await findOwnWindowWithRetry(win);
        if (!info) return { supported: false, reason: 'KWin did not report this window (is it shown?).', knownGaps: KNOWN_GAPS };
        if (info.excludeFromCapture === undefined) {
          return { supported: false, reason: 'This KWin has no excludeFromCapture property. Plasma 6.6 or newer is required.', knownGaps: KNOWN_GAPS };
        }
        return { supported: true, reason: 'KWin exposes excludeFromCapture.', knownGaps: KNOWN_GAPS };
      } catch (e) {
        return { supported: false, reason: `Could not query KWin over D-Bus: ${(e as Error).message}`, knownGaps: KNOWN_GAPS };
      }
    },

    async apply(win, exclude) {
      try {
        const info = await findOwnWindowWithRetry(win);
        if (!info) return { ok: false, error: 'KWin did not report this window.' };
        await runOneShotScript(buildExclusionScript({ uuid: info.uuid, pid: process.pid, exclude }));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async readBack(win) {
      try {
        const info = await findOwnWindow(win);
        if (!info) return { excluded: 'unknown', detail: 'KWin did not report this window.' };
        if (info.excludeFromCapture === undefined) return { excluded: 'unknown', detail: 'KWin did not return excludeFromCapture.' };
        return { excluded: info.excludeFromCapture, detail: `KWin window ${info.uuid}: excludeFromCapture=${info.excludeFromCapture}` };
      } catch (e) {
        return { excluded: 'unknown', detail: `Readback failed: ${(e as Error).message}` };
      }
    },
  };
}
