import { describe, expect, it, vi } from 'vitest';
import { AudioController } from '../src/main/audio/AudioController';
import type { AudioStatus } from '../src/shared/audio';

function setup() {
  const seen: AudioStatus[] = [];
  const c = new AudioController(() => new Date('2026-10-14T12:00:00Z'));
  c.onChange((s) => seen.push(s));
  return { c, seen };
}

describe('AudioController', () => {
  it('is inactive by default, so the mic is not allowed', () => {
    const { c } = setup();
    expect(c.get()).toEqual({ active: false, kind: null, since: null, meetingConsented: false });
    expect(c.micAllowed).toBe(false);
  });

  it('allows the mic only while a session is active', () => {
    const { c } = setup();
    c.start('mic-test');
    expect(c.micAllowed).toBe(true);
    expect(c.get()).toMatchObject({ active: true, kind: 'mic-test', since: '2026-10-14T12:00:00.000Z' });
    c.stop();
    expect(c.micAllowed).toBe(false);
    expect(c.get().kind).toBeNull();
  });

  it('refuses a meeting recording until consent is given', () => {
    const { c } = setup();
    expect(() => c.start('meeting')).toThrow(/consent/);
    expect(c.micAllowed).toBe(false);
    c.consentToMeeting();
    c.start('meeting');
    expect(c.get()).toMatchObject({ active: true, kind: 'meeting', meetingConsented: true });
  });

  it('allows practice without meeting consent', () => {
    const { c } = setup();
    c.start('practice');
    expect(c.micAllowed).toBe(true);
  });

  it('notifies listeners on start, stop and consent', () => {
    const { c, seen } = setup();
    c.consentToMeeting();
    c.start('practice');
    c.stop();
    expect(seen.map((s) => [s.active, s.kind, s.meetingConsented])).toEqual([
      [false, null, true],
      [true, 'practice', true],
      [false, null, true],
    ]);
  });

  it('stop is idempotent', () => {
    const { c, seen } = setup();
    c.stop();
    expect(seen).toEqual([]);
  });
});
