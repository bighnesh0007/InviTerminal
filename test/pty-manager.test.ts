import * as nodePty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SESSIONS, PtyManager, type PtyLike, type SpawnPty } from '../src/main/terminal/PtyManager';
import type { ShellProfile } from '../src/main/terminal/shells';

const PROFILES: { profiles: ShellProfile[]; defaultId: string } = {
  profiles: [
    { id: 'bash', label: 'bash', file: '/usr/bin/bash', args: [] },
    { id: 'sh', label: 'sh', file: '/bin/sh', args: [] },
  ],
  defaultId: 'bash',
};

class FakePty implements PtyLike {
  static last: FakePty;
  pid = 4242;
  written: string[] = [];
  paused = 0;
  resumed = 0;
  killed = false;
  size: [number, number] = [80, 24];
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => {};
  constructor(
    public file: string,
    public args: string[],
  ) {
    FakePty.last = this;
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb;
    return { dispose() {} };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.size = [c, r];
  }
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  emit(d: string) {
    this.dataCb(d);
  }
  exit(code: number) {
    this.exitCb({ exitCode: code });
  }
}

function setup(spawnPty: SpawnPty = (f, a) => new FakePty(f, a)) {
  const data: [string, string][] = [];
  const exits: [string, number][] = [];
  const m = new PtyManager(spawnPty, PROFILES, () => ({ TERM: 'xterm-256color' }), '/tmp', {
    data: (id, d) => data.push([id, d]),
    exit: (id, code) => exits.push([id, code]),
  });
  return { m, data, exits };
}

afterEach(() => vi.useRealTimers());

describe('PtyManager (fake pty)', () => {
  it('spawns the file and args from the profile table — the caller only names a profile', () => {
    const { m } = setup();
    m.spawn('sh');
    expect(FakePty.last.file).toBe('/bin/sh');
    expect(FakePty.last.args).toEqual([]);
    m.spawn();
    expect(FakePty.last.file).toBe('/usr/bin/bash');
  });

  it('rejects unknown profiles', () => {
    const { m } = setup();
    expect(() => m.spawn('/bin/sh')).toThrow(/Unknown shell profile/);
  });

  it('caps the number of sessions', () => {
    const { m } = setup();
    for (let i = 0; i < MAX_SESSIONS; i++) m.spawn();
    expect(() => m.spawn()).toThrow();
  });

  it('routes input and resize to the right session and ignores unknown ids', () => {
    const { m } = setup();
    const a = m.spawn();
    const ptyA = FakePty.last;
    m.spawn();
    m.input(a.sessionId, 'ls\r');
    m.resize(a.sessionId, 120, 40);
    m.input('00000000-0000-0000-0000-000000000000', 'nope');
    expect(ptyA.written).toEqual(['ls\r']);
    expect(ptyA.size).toEqual([120, 40]);
    expect(m.stats(a.sessionId)?.size).toEqual({ cols: 120, rows: 40 });
    expect(FakePty.last.written).toEqual([]);
  });

  it('coalesces output into one send per batch window', () => {
    vi.useFakeTimers();
    const { m, data } = setup();
    const s = m.spawn();
    FakePty.last.emit('a');
    FakePty.last.emit('b');
    FakePty.last.emit('c');
    expect(data).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(data).toEqual([[s.sessionId, 'abc']]);
  });

  it('pauses the pty when the renderer falls behind and resumes when it acknowledges', () => {
    const { m } = setup();
    const s = m.spawn();
    const pty = FakePty.last;
    pty.emit('x'.repeat(70_000)); // ≥ batch max: flushed immediately
    pty.emit('x'.repeat(70_000));
    expect(pty.paused).toBe(1);
    m.ack(s.sessionId, 140_000);
    expect(pty.resumed).toBe(1);
  });

  it('flushes pending output before reporting exit, then forgets the session', () => {
    vi.useFakeTimers();
    const { m, data, exits } = setup();
    const s = m.spawn();
    FakePty.last.emit('bye');
    FakePty.last.exit(3);
    expect(data).toEqual([[s.sessionId, 'bye']]);
    expect(exits).toEqual([[s.sessionId, 3]]);
    expect(m.size).toBe(0);
  });

  it('killAll kills every pty', () => {
    const { m } = setup();
    m.spawn();
    const a = FakePty.last;
    m.spawn();
    m.killAll();
    expect(a.killed && FakePty.last.killed).toBe(true);
    expect(m.size).toBe(0);
  });
});

describe('PtyManager (real node-pty, /bin/sh)', () => {
  const real: SpawnPty = (file, args, opts) => nodePty.spawn(file, args, opts);

  it('runs a command, reports its output and exit code', async () => {
    const { m, data, exits } = setup(real);
    const s = m.spawn('sh');
    m.input(s.sessionId, "printf 'invi-%s\\n' roundtrip; exit 4\r");
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5000 });
    expect(data.map(([, d]) => d).join('')).toContain('invi-roundtrip');
    expect(exits[0]).toEqual([s.sessionId, 4]);
  });

  it('applies resize to the real tty', async () => {
    const { m, data, exits } = setup(real);
    const s = m.spawn('sh');
    m.resize(s.sessionId, 101, 33);
    m.input(s.sessionId, 'stty size; exit 0\r');
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5000 });
    expect(data.map(([, d]) => d).join('')).toContain('33 101');
  });
});
