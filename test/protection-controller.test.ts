import type { BrowserWindow } from 'electron';
import { describe, expect, it } from 'vitest';
import { ProtectionController } from '../src/main/capture/ProtectionController';
import type { ApplyResult, CaptureExclusionProvider, ReadbackResult } from '../src/main/capture/types';
import type { ProtectionState, SelfTestRecord } from '../src/shared/protection';

function fakeProvider(opts: { supported?: boolean; apply?: ApplyResult; readback?: ReadbackResult['excluded'] } = {}) {
  let flag: boolean | 'unknown' = false;
  const provider: CaptureExclusionProvider & { setFlag(v: boolean | 'unknown'): void } = {
    id: 'kwin',
    setFlag: (v) => (flag = v),
    probe: async () => ({ supported: opts.supported ?? true, reason: 'fake', knownGaps: ['gap'] }),
    apply: async (_w, exclude) => {
      const r = opts.apply ?? { ok: true };
      if (r.ok && opts.readback === undefined) flag = exclude;
      return r;
    },
    readBack: async () => ({ excluded: opts.readback ?? flag, detail: 'fake readback' }),
  };
  return provider;
}

function setup(provider: CaptureExclusionProvider) {
  const states: ProtectionState[] = [];
  const c = new ProtectionController(provider, {} as BrowserWindow, (s) => states.push(s), () => new Date('2026-10-14T12:00:00Z'));
  return { c, states };
}

const test = (verdict: SelfTestRecord['verdict']): SelfTestRecord => ({ path: 'kwin-screenshot', verdict, reason: 'r', at: '2026-10-14T12:01:00Z', detail: '' });

describe('ProtectionController', () => {
  it('reaches readback-confirmed — not further — when apply and readback agree', async () => {
    const { c } = setup(fakeProvider());
    await c.initialise();
    expect(c.get().level).toBe('readback-confirmed');
    expect(c.get().appliedAt).toBe('2026-10-14T12:00:00.000Z');
  });

  it('does not trust a successful apply when readback disagrees', async () => {
    const { c } = setup(fakeProvider({ readback: false }));
    await c.initialise();
    expect(c.get().level).toBe('request-failed');
  });

  it('stays at "requested" when readback is unavailable', async () => {
    const { c } = setup(fakeProvider({ readback: 'unknown' }));
    await c.initialise();
    expect(c.get().level).toBe('requested');
  });

  it('reports request-failed when apply fails', async () => {
    const { c } = setup(fakeProvider({ apply: { ok: false, error: 'boom' } }));
    await c.initialise();
    expect(c.get().level).toBe('request-failed');
    expect(c.get().detail).toContain('boom');
  });

  it('reports unsupported and never applies when the probe fails', async () => {
    const { c } = setup(fakeProvider({ supported: false }));
    await c.initialise();
    await c.protect();
    expect(c.get().level).toBe('unsupported');
  });

  it('only a passing self-test after readback reaches selftest-passed', async () => {
    const { c } = setup(fakeProvider());
    await c.initialise();
    c.recordSelfTest(test('inconclusive'));
    expect(c.get().level).toBe('readback-confirmed');
    c.recordSelfTest(test('pass'));
    expect(c.get().level).toBe('selftest-passed');
  });

  it('a failing self-test overrides an earlier pass', async () => {
    const { c } = setup(fakeProvider());
    await c.initialise();
    c.recordSelfTest(test('pass'));
    c.recordSelfTest(test('fail'));
    expect(c.get().level).toBe('selftest-failed');
  });

  it('re-applying drops back to readback-confirmed: old self-tests do not carry over', async () => {
    const { c } = setup(fakeProvider());
    await c.initialise();
    c.recordSelfTest(test('pass'));
    await c.protect();
    expect(c.get().level).toBe('readback-confirmed');
    expect(c.get().selfTests).toHaveLength(1);
  });

  it('a self-test while unprotected is recorded but changes nothing', async () => {
    const { c } = setup(fakeProvider());
    await c.initialise();
    await c.unprotect();
    c.recordSelfTest(test('fail'));
    expect(c.get().level).toBe('unprotected');
    expect(c.get().selfTests[0]?.verdict).toBe('fail');
  });

  it('recheck notices the flag being cleared outside the app', async () => {
    const p = fakeProvider();
    const { c } = setup(p);
    await c.initialise();
    p.setFlag(false);
    await c.recheck();
    expect(c.get().level).toBe('unprotected');
  });

  it('recheck notices the flag being set outside the app', async () => {
    const p = fakeProvider();
    const { c } = setup(p);
    await c.initialise();
    await c.unprotect();
    p.setFlag(true);
    await c.recheck();
    expect(c.get().level).toBe('readback-confirmed');
  });

  it('recheck downgrades a passed self-test when the flag can no longer be read (e.g. window re-created)', async () => {
    const p = fakeProvider();
    const { c } = setup(p);
    await c.initialise();
    c.recordSelfTest(test('pass'));
    p.setFlag('unknown');
    await c.recheck();
    expect(c.get().level).toBe('requested');
  });

  it('serialises concurrent operations', async () => {
    const p = fakeProvider();
    const { c, states } = setup(p);
    await Promise.all([c.initialise(), c.recheck(), c.protect(), c.recheck()]);
    expect(c.get().level).toBe('readback-confirmed');
    // initialise and protect each pass through 'requested' before confirming.
    expect(states.filter((s) => s.level === 'requested')).toHaveLength(2);
  });
});
