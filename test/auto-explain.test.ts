import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createErrorWatcher, looksLikeError, stripAnsi } from '../src/renderer/error-detect';
import { SettingsStore } from '../src/main/settings/SettingsStore';
import { SettingsPatchSchema } from '../src/main/settings/schema';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

describe('looksLikeError (heuristic failure detection)', () => {
  const failures: Record<string, string> = {
    'command not found': 'bash: frobnicate: command not found',
    'missing file': "cat: notes.txt: No such file or directory",
    'permission': 'bash: ./deploy.sh: Permission denied',
    'segfault': 'Segmentation fault (core dumped)',
    'python traceback': 'Traceback (most recent call last):\n  File "app.py", line 3, in <module>',
    'python exception': 'ZeroDivisionError: division by zero',
    'js type error': "TypeError: Cannot read properties of undefined (reading 'x')",
    'js stack frame': '    at Object.<anonymous> (/srv/app/index.js:12:7)',
    'git fatal': 'fatal: not a git repository (or any of the parent directories): .git',
    'npm': 'npm ERR! code ENOENT',
    'rust': 'error[E0425]: cannot find value `x` in this scope',
    'go panic': 'panic: runtime error: index out of range [3] with length 3',
    'gcc': 'gcc: error: main.c: No such file or directory',
    'bare Error:': 'Error: listen EADDRINUSE: address already in use :::3000',
  };
  for (const [name, text] of Object.entries(failures)) {
    it(`detects: ${name}`, () => expect(looksLikeError(text)).toBe(true));
  }

  // Benign output that merely contains error-ish words must NOT fire (false-positive resistance).
  const benign: Record<string, string> = {
    'ls listing': 'README.md  package.json  src  test',
    'prompt': 'bighnesh@arch ~/project $ ',
    'zero errors summary': 'Build finished: 0 errors, 2 warnings',
    'no errors found': 'Lint passed. No errors found.',
    'word "errors" plural': 'Retrieved 12 records, logged errors to file',
    'git status clean': 'On branch main\nnothing to commit, working tree clean',
    'mid-line error mention': 'the error handler was refactored last week',
  };
  for (const [name, text] of Object.entries(benign)) {
    it(`ignores: ${name}`, () => expect(looksLikeError(text)).toBe(false));
  }

  it('sees through ANSI colour codes', () => {
    const coloured = '\x1b[31mError: \x1b[1mboom\x1b[0m';
    expect(stripAnsi(coloured)).toBe('Error: boom');
    expect(looksLikeError(coloured)).toBe(false); // raw (with codes) - the watcher strips first
    expect(looksLikeError(stripAnsi(coloured))).toBe(true);
  });
});

/** A manual clock + timer queue, so debounce/cooldown are deterministic (no real waiting). */
function harness(opts: { debounceMs?: number; cooldownMs?: number; bufferLines?: number; accept?: () => boolean } = {}) {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const fired: string[] = [];
  const w = createErrorWatcher((recent) => {
    fired.push(recent);
    return opts.accept ? opts.accept() : true;
  }, {
    debounceMs: opts.debounceMs ?? 500,
    cooldownMs: opts.cooldownMs ?? 8000,
    ...(opts.bufferLines !== undefined ? { bufferLines: opts.bufferLines } : {}),
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => {
      timers = timers.filter((x) => x.id !== (h as unknown as number));
    },
  });
  const advance = (ms: number) => {
    t += ms;
    const due = timers.filter((x) => x.at <= t);
    timers = timers.filter((x) => x.at > t);
    for (const d of due) d.fn();
  };
  return { w, fired, advance, pending: () => timers.length };
}

describe('createErrorWatcher', () => {
  it('does nothing for normal output', () => {
    const h = harness();
    h.w.feed('ls\r\nREADME.md  src\r\n$ ');
    h.advance(10_000);
    expect(h.fired).toEqual([]);
  });

  it('fires once, after the debounce, with the recent context', () => {
    const h = harness();
    h.w.feed('$ python app.py\r\n');
    h.w.feed('Traceback (most recent call last):\r\n');
    expect(h.fired).toEqual([]); // waits for the rest of the trace
    h.w.feed('  File "app.py", line 3\r\nZeroDivisionError: division by zero\r\n');
    h.advance(499);
    expect(h.fired).toEqual([]);
    h.advance(1);
    expect(h.fired.length).toBe(1);
    // The whole trace (and the command) is in the context, ANSI/CR stripped.
    expect(h.fired[0]).toContain('$ python app.py');
    expect(h.fired[0]).toContain('ZeroDivisionError: division by zero');
    expect(h.fired[0]).not.toContain('\r');
  });

  it('one burst = one event (a long trace does not fire repeatedly)', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.w.feed(`    at fn${i} (/a/b.js:${i}:1)\n`);
    h.advance(600);
    expect(h.fired.length).toBe(1);
  });

  it('cooldown suppresses a second error soon after, then allows it again', () => {
    const h = harness({ cooldownMs: 8000 });
    h.w.feed('bash: foo: command not found\n');
    h.advance(500);
    expect(h.fired.length).toBe(1);
    h.advance(2000); // 2.5s after the first error
    h.w.feed('bash: bar: command not found\n');
    h.advance(500);
    expect(h.fired.length).toBe(1); // suppressed: still cooling down
    h.advance(8000);
    h.w.feed('bash: baz: command not found\n');
    h.advance(500);
    expect(h.fired.length).toBe(2); // cooldown over: fires again
  });

  it('a detection nobody acted on does NOT start the cooldown (regression: feature off, then on)', () => {
    // Found by the real-app autotest: with the feature OFF, an error was detected (and ignored),
    // which still started the 8s cooldown — so turning the feature ON and failing again within
    // 8s silently did nothing. Only an accepted detection may start the cooldown.
    let acting = false;
    const h = harness({ cooldownMs: 8000, accept: () => acting });
    h.w.feed('bash: foo: command not found\n'); // feature OFF: detected, not acted on
    h.advance(500);
    expect(h.fired.length).toBe(1);
    acting = true; // user turns the feature on
    h.advance(1500); // ~2s later, well within what would have been the cooldown
    h.w.feed('bash: bar: command not found\n');
    h.advance(500);
    expect(h.fired.length).toBe(2); // fires — the ignored detection did not suppress it
    h.advance(1000);
    h.w.feed('bash: baz: command not found\n'); // this one IS within the cooldown of an accepted fire
    h.advance(500);
    expect(h.fired.length).toBe(2);
  });

  it('only reacts to fresh output: an old buffered error does not re-trigger', () => {
    const h = harness({ cooldownMs: 1000 });
    h.w.feed('bash: foo: command not found\n');
    h.advance(500);
    expect(h.fired.length).toBe(1);
    h.advance(5000); // well past cooldown
    h.w.feed('echo hi\nhi\n$ '); // benign; the old error is still in the buffer
    h.advance(1000);
    expect(h.fired.length).toBe(1);
  });

  it('reset() cancels a pending fire and clears the buffer', () => {
    const h = harness();
    h.w.feed('fatal: not a git repository\n');
    expect(h.pending()).toBe(1);
    h.w.reset();
    expect(h.pending()).toBe(0);
    h.advance(1000);
    expect(h.fired).toEqual([]);
  });

  it('caps the reported context to the last N lines', () => {
    const h = harness({ bufferLines: 5 });
    for (let i = 0; i < 50; i++) h.w.feed(`line ${i}\n`);
    h.w.feed('Error: boom\n');
    h.advance(500);
    const lines = h.fired[0]!.split('\n');
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(h.fired[0]).toContain('Error: boom');
    expect(h.fired[0]).not.toContain('line 0');
  });

  it('a throwing onDetect cannot break feeding (the timer callback is isolated)', () => {
    // Defensive: the renderer wraps onOutput, but the watcher itself must keep working.
    let calls = 0;
    let t = 0;
    const queue: (() => void)[] = [];
    const w = createErrorWatcher(
      () => {
        calls++;
        throw new Error('ui exploded');
      },
      { debounceMs: 1, cooldownMs: 0, now: () => t, setTimer: (fn) => (queue.push(fn), 1 as unknown as ReturnType<typeof setTimeout>), clearTimer: () => {} },
    );
    w.feed('Error: one\n');
    expect(() => queue.shift()!()).toThrow('ui exploded');
    t += 10;
    // Still usable afterwards: a new error schedules again.
    w.feed('Error: two\n');
    expect(queue.length).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('autoExplainErrors setting', () => {
  it('is OFF by default', () => {
    expect(DEFAULT_SETTINGS.ai.autoExplainErrors).toBe(false);
  });

  it('a settings.json from the previous release (no field) still loads, with the feature off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invi-autoexplain-'));
    // Exactly what the previous release wrote: ai has only `model`.
    const old = { ...structuredClone(DEFAULT_SETTINGS), ai: { model: DEFAULT_SETTINGS.ai.model } };
    await writeFile(join(dir, 'settings.json'), JSON.stringify(old));
    const s = SettingsStore.loadSync(dir);
    expect(s.view().loadWarning).toBeNull(); // not treated as corrupt
    expect(s.effective().ai.autoExplainErrors).toBe(false);
    expect(s.effective().ai.model).toBe(DEFAULT_SETTINGS.ai.model);
  });

  it('can be turned on, persists, and survives a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invi-autoexplain-'));
    const s = SettingsStore.loadSync(dir);
    await s.update(SettingsPatchSchema.parse({ ai: { autoExplainErrors: true } }) as Parameters<SettingsStore['update']>[0]);
    const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.ai.autoExplainErrors).toBe(true);
    expect(SettingsStore.loadSync(dir).effective().ai.autoExplainErrors).toBe(true);
  });

  it('turning it on does not change the model, and vice versa', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invi-autoexplain-'));
    const s = SettingsStore.loadSync(dir);
    const model = s.effective().ai.model;
    await s.update({ ai: { autoExplainErrors: true } });
    expect(s.effective().ai.model).toBe(model);
  });

  it('the IPC patch schema refuses a non-boolean or an unknown ai key', () => {
    expect(() => SettingsPatchSchema.parse({ ai: { autoExplainErrors: 'yes' } })).toThrow();
    expect(() => SettingsPatchSchema.parse({ ai: { autoExplainErrors: true, sneaky: 1 } })).toThrow();
    expect(SettingsPatchSchema.parse({ ai: { autoExplainErrors: false } })).toEqual({ ai: { autoExplainErrors: false } });
  });
});
