import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isUsageAction, USAGE_ACTION_LABELS, USAGE_ACTIONS, type UsageCounts, type UsageRow, type UsageView } from '../../shared/usage';

const FILE = 'usage.json';

const Entry = z.object({ count: z.number().int().nonnegative().max(1e12), lastUsed: z.string().min(1).max(40) }).strict();
const Stored = z.record(z.string(), Entry);

/**
 * Local-only usage counters. Stores ONLY static action IDs, counts and a last-used timestamp —
 * never commands, transcripts, prompts, answers or any content. The file lives in the app data
 * dir (never MongoDB) and is never sent anywhere.
 *
 * Writes are atomic (temp file + rename, 0600) and debounced so a burst of clicks is one write.
 * An unreadable or schema-invalid file is reset (moved aside), never fatal. Everything here is
 * best-effort: tracking a usage event must never throw into, slow, or crash the app, so `track`
 * and the write path swallow their own errors.
 */
export class UsageStore {
  private counts: UsageCounts;
  private readonly loadWarning: string | null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  /** Serializes writes so two flushes can't interleave on the same file. */
  private writing: Promise<void> = Promise.resolve();
  /** Async writes queued or running (counted from the moment flush() takes the snapshot). */
  private pendingWrites = 0;
  /** Set by flushSync at quit: queued async writes then stand down instead of renaming. */
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly debounceMs = 1000,
  ) {
    const r = UsageStore.read(join(dir, FILE), now);
    this.counts = r.counts;
    this.loadWarning = r.warning;
  }

  private static read(path: string, now: () => Date): { counts: UsageCounts; warning: string | null } {
    let raw: string | null = null;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { counts: {}, warning: null };
      return { counts: {}, warning: 'usage.json could not be read; usage counts start fresh.' };
    }
    try {
      const parsed = Stored.parse(JSON.parse(raw));
      // Keep only known action IDs, so a retired action self-heals out of the file on next write.
      const counts: UsageCounts = {};
      for (const [k, v] of Object.entries(parsed)) if (isUsageAction(k)) counts[k] = { count: v.count, lastUsed: v.lastUsed };
      return { counts, warning: null };
    } catch {
      try {
        renameSync(path, `${path}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`);
      } catch {
        // Can't move it aside — the write path will overwrite it atomically later. Non-fatal.
      }
      return { counts: {}, warning: 'usage.json was unreadable and has been reset.' };
    }
  }

  /** Count one use of `action`. Unknown IDs are ignored. Never throws. */
  track(action: string): void {
    try {
      if (!isUsageAction(action)) return;
      const e = this.counts[action] ?? { count: 0, lastUsed: '' };
      e.count += 1;
      e.lastUsed = this.now().toISOString();
      this.counts[action] = e;
      this.schedule();
    } catch {
      // Tracking must never affect the application.
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    // A pending usage flush should never keep the process alive on quit.
    this.timer.unref?.();
  }

  view(): UsageView {
    const rows: UsageRow[] = USAGE_ACTIONS.map((a) => {
      const e = this.counts[a];
      return { action: a, label: USAGE_ACTION_LABELS[a], count: e?.count ?? 0, lastUsed: e?.lastUsed ?? null };
    });
    // Most-used first; ties broken by label so the order is stable.
    rows.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return { rows, total, file: join(this.dir, FILE), loadWarning: this.loadWarning };
  }

  /** JSON a user can keep (the same shape the Usage table shows). */
  exportJson(): string {
    return `${JSON.stringify(this.view(), null, 2)}\n`;
  }

  /** Wipe all counters (user action in Settings) and persist immediately. */
  async reset(): Promise<void> {
    this.counts = {};
    this.dirty = true;
    await this.flush();
  }

  /** Persist pending changes now. Serialized with any in-flight write. Never rejects. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = structuredClone(this.counts);
    this.pendingWrites++;
    const run = async () => {
      const tmp = join(this.dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600); // in case umask widened it
        // flushSync already wrote a newer superset at quit; renaming this older snapshot over it would lose data.
        if (this.closed) {
          await rm(tmp, { force: true });
          return;
        }
        await rename(tmp, join(this.dir, FILE));
      } catch {
        // A failed usage write must never surface to the user.
      } finally {
        this.pendingWrites--;
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /**
   * Synchronous final flush for app quit. An async flush can't be awaited at quit — the process
   * exits first — so without this, anything tracked in the last debounce window was lost.
   * Writes the full current counts (a superset of any queued snapshot), then marks the store
   * closed so queued async writes skip their rename. Never throws.
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const needed = this.dirty || this.pendingWrites > 0;
    this.closed = true;
    if (!needed) return;
    this.dirty = false;
    try {
      const tmp = join(this.dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(this.counts, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, join(this.dir, FILE));
    } catch {
      // A failed usage write must never surface to the user.
    }
  }
}
