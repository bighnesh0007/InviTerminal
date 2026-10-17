import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/main/usage/UsageStore';
import { isUsageAction, USAGE_ACTIONS } from '../src/shared/usage';
import { track } from '../src/renderer/usage';
import type { RendererApi } from '../src/shared/ipc';

const tempDir = () => mkdtempSync(join(tmpdir(), 'invi-usage-'));
const FIXED = () => new Date('2026-10-17T12:00:00.000Z');
const FILE = 'usage.json';

describe('shared/usage', () => {
  it('only recognises the centralized action list', () => {
    expect(isUsageAction('panel.live')).toBe(true);
    expect(isUsageAction('not.a.real.action')).toBe(false);
    expect(isUsageAction('')).toBe(false);
  });
});

describe('UsageStore', () => {
  it('starts empty: every known action present with count 0, total 0', () => {
    const s = new UsageStore(tempDir(), FIXED);
    const v = s.view();
    expect(v.total).toBe(0);
    expect(v.rows.length).toBe(USAGE_ACTIONS.length);
    expect(v.rows.every((r) => r.count === 0 && r.lastUsed === null)).toBe(true);
    expect(v.file.endsWith(FILE)).toBe(true);
    expect(v.loadWarning).toBeNull();
  });

  it('increments counts and records last-used time', () => {
    const s = new UsageStore(tempDir(), FIXED);
    s.track('panel.live');
    s.track('panel.live');
    s.track('ai.explain');
    const byAction = Object.fromEntries(s.view().rows.map((r) => [r.action, r]));
    expect(byAction['panel.live']!.count).toBe(2);
    expect(byAction['panel.live']!.lastUsed).toBe('2026-10-17T12:00:00.000Z');
    expect(byAction['ai.explain']!.count).toBe(1);
    expect(s.view().total).toBe(3);
  });

  it('sorts most-used first, ties broken by label', () => {
    const s = new UsageStore(tempDir(), FIXED);
    s.track('panel.live');
    s.track('panel.live');
    s.track('panel.library');
    const rows = s.view().rows;
    expect(rows[0]!.action).toBe('panel.live'); // highest count first
    // The two single-count winners are ordered by label, not insertion.
    const ones = rows.filter((r) => r.count === 1).map((r) => r.label);
    expect(ones).toEqual([...ones].sort((a, b) => a.localeCompare(b)));
  });

  it('ignores unknown action IDs (never throws, never stored on disk)', async () => {
    const dir = tempDir();
    const s = new UsageStore(dir, FIXED);
    expect(() => s.track('totally.made.up')).not.toThrow();
    expect(() => s.track('')).not.toThrow();
    s.track('panel.live'); // one real action so there is something to flush
    await s.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    // The unknown IDs must never reach the file — view().total hides them, so assert on disk.
    expect(Object.keys(onDisk)).toEqual(['panel.live']);
  });

  it('never throws even if the clock throws (tracking is best-effort)', () => {
    const boom = () => {
      throw new Error('clock exploded');
    };
    const s = new UsageStore(tempDir(), boom);
    expect(() => s.track('panel.live')).not.toThrow();
    expect(s.view().total).toBe(0); // the increment was abandoned, but the app is unharmed
  });

  it('persists atomically (0600) and reloads', async () => {
    const dir = tempDir();
    const s = new UsageStore(dir, FIXED);
    s.track('live.ask');
    s.track('live.ask');
    s.track('live.clear');
    await s.flush();

    const path = join(dir, FILE);
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    // No leftover temp files from the atomic write.
    expect(readdirSync(dir).filter((f) => f.startsWith('.') && f.includes('tmp'))).toEqual([]);

    const reloaded = new UsageStore(dir, FIXED);
    const byAction = Object.fromEntries(reloaded.view().rows.map((r) => [r.action, r.count]));
    expect(byAction['live.ask']).toBe(2);
    expect(byAction['live.clear']).toBe(1);
    expect(reloaded.view().loadWarning).toBeNull();
  });

  it('coalesces a burst of tracks into one correct on-disk result', async () => {
    const dir = tempDir();
    const s = new UsageStore(dir, FIXED);
    for (let i = 0; i < 100; i++) s.track('terminal.newTab');
    for (let i = 0; i < 40; i++) s.track('terminal.closeTab');
    await s.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    expect(onDisk['terminal.newTab'].count).toBe(100);
    expect(onDisk['terminal.closeTab'].count).toBe(40);
  });

  it('overlapping flushes converge to the correct final count (no lost update)', async () => {
    // Each flush snapshots current counts and the writes are chained, so a track that lands
    // between two in-flight flushes is still on disk once both resolve.
    const dir = tempDir();
    const s = new UsageStore(dir, FIXED);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      s.track('panel.audio'); // known action, incremented 25 times
      pending.push(s.flush()); // each flush left un-awaited, so writes overlap
    }
    await Promise.all(pending);
    await s.flush(); // final flush observes all increments and lands last
    const onDisk = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    expect(onDisk['panel.audio'].count).toBe(25);
  });

  it('flush with nothing dirty is a safe no-op', async () => {
    const s = new UsageStore(tempDir(), FIXED);
    await expect(s.flush()).resolves.toBeUndefined();
  });

  it('resets counts and persists the empty state', async () => {
    const dir = tempDir();
    const s = new UsageStore(dir, FIXED);
    s.track('panel.live');
    await s.flush();
    await s.reset();
    expect(s.view().total).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, FILE), 'utf8'))).toEqual({});
    // A fresh store sees the reset too.
    expect(new UsageStore(dir, FIXED).view().total).toBe(0);
  });

  it('exports the view as JSON', () => {
    const s = new UsageStore(tempDir(), FIXED);
    s.track('company.nope' as string); // ignored
    s.track('panel.settings');
    const parsed = JSON.parse(s.exportJson());
    expect(parsed.total).toBe(1);
    expect(parsed.rows.find((r: { action: string }) => r.action === 'panel.settings').count).toBe(1);
  });

  it('resets a corrupt (non-JSON) file, moves it aside, and warns', () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILE), '{ this is not json');
    const s = new UsageStore(dir, FIXED);
    expect(s.view().total).toBe(0);
    expect(s.view().loadWarning).toMatch(/unreadable/);
    expect(readdirSync(dir).some((f) => f.startsWith(`${FILE}.corrupt-`))).toBe(true);
  });

  it('resets a schema-invalid file (valid JSON, wrong shape)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILE), JSON.stringify({ 'panel.live': { count: 'lots', lastUsed: 5 } }));
    const s = new UsageStore(dir, FIXED);
    expect(s.view().total).toBe(0);
    expect(s.view().loadWarning).toMatch(/unreadable/);
  });

  it('drops unknown (retired) action IDs from a valid file on load', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, FILE),
      JSON.stringify({ 'panel.live': { count: 3, lastUsed: '2026-01-01T00:00:00.000Z' }, 'retired.feature': { count: 9, lastUsed: '2026-01-01T00:00:00.000Z' } }),
    );
    const s = new UsageStore(dir, FIXED);
    expect(s.view().total).toBe(3); // the retired count is not shown
    expect(s.view().loadWarning).toBeNull();
    // ...and it self-heals out of the file on the next write.
    s.track('panel.live');
    await s.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    expect(onDisk['retired.feature']).toBeUndefined();
    expect(onDisk['panel.live'].count).toBe(4);
  });

  describe('flushSync (app quit)', () => {
    it('persists a still-debounced increment immediately, with no await', () => {
      // Regression: the quit hook used an async flush, which the exiting process cut off — an
      // action in the last second before quit (e.g. Explain → close) was silently lost.
      const dir = tempDir();
      const s = new UsageStore(dir, FIXED);
      s.track('ai.explain');
      s.flushSync();
      const onDisk = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
      expect(onDisk['ai.explain'].count).toBe(1);
      expect(statSync(join(dir, FILE)).mode & 0o777).toBe(0o600);
    });

    it('writes nothing when nothing is pending', () => {
      const dir = tempDir();
      new UsageStore(dir, FIXED).flushSync();
      expect(readdirSync(dir)).toEqual([]);
    });

    it('a write queued just before quit is not lost (flushSync covers it)', async () => {
      const dir = tempDir();
      const s = new UsageStore(dir, FIXED);
      s.track('panel.live');
      const queued = s.flush(); // took the snapshot, but its write hasn't run yet
      s.flushSync(); // quit happens right now
      expect(JSON.parse(readFileSync(join(dir, FILE), 'utf8'))['panel.live'].count).toBe(1);
      await queued;
      expect(JSON.parse(readFileSync(join(dir, FILE), 'utf8'))['panel.live'].count).toBe(1);
    });

    it('a queued older snapshot cannot overwrite the newer quit-time write', async () => {
      const dir = tempDir();
      const s = new UsageStore(dir, FIXED);
      s.track('panel.live');
      const queued = s.flush(); // snapshot: count 1
      s.track('panel.live'); // count 2, after the snapshot
      s.flushSync(); // writes count 2
      await queued; // the stale count-1 write must stand down, not rename over it
      expect(JSON.parse(readFileSync(join(dir, FILE), 'utf8'))['panel.live'].count).toBe(2);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // its temp file was removed
    });
  });

  it('a failed write never rejects (tracking must not crash the app)', async () => {
    // A directory that does not exist makes the atomic write fail; flush must still resolve.
    const s = new UsageStore(join(tmpdir(), 'invi-usage-does-not-exist-xyz'), FIXED);
    s.track('panel.live');
    await expect(s.flush()).resolves.toBeUndefined();
  });
});

describe('renderer track() helper', () => {
  it('swallows a throwing api and a missing usage surface', () => {
    const throwing = { usage: { track: () => { throw new Error('ipc down'); } } } as unknown as RendererApi;
    expect(() => track(throwing, 'panel.live')).not.toThrow();
    const missing = {} as unknown as RendererApi;
    expect(() => track(missing, 'panel.live')).not.toThrow();
  });

  it('forwards a valid action to the api', () => {
    const calls: string[] = [];
    const api = { usage: { track: (a: string) => calls.push(a) } } as unknown as RendererApi;
    track(api, 'live.summarize');
    expect(calls).toEqual(['live.summarize']);
  });
});
