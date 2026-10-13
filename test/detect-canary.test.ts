import { describe, expect, it } from 'vitest';
import { sequenceFromBytes } from '../src/shared/canary';
import { findCanary } from '../src/shared/detect-canary';
import { addNoise, blankFrame, drawCanary, fillRect, noisyFrame, scale, toBgra, warmShift } from './helpers/frames';

const SEQ = sequenceFromBytes(Uint8Array.from([7, 200, 13, 99, 42, 250, 3, 128, 77, 61, 190, 5]));
const OTHER = sequenceFromBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));

function frameWithCanary(seed = 1) {
  const f = noisyFrame(800, 500, seed);
  drawCanary(f, SEQ, 137, 211, 24, 120);
  return f;
}

describe('findCanary — positives', () => {
  it('finds the canary at its drawn position', () => {
    const r = findCanary(frameWithCanary(), SEQ);
    expect(r.found).toBe(true);
    expect(r.firstMatch).toMatchObject({ x: 137, stripePx: 24 });
    expect(r.firstMatch!.y).toBeGreaterThanOrEqual(211);
  });

  it.each([0.75, 1.25, 1.5, 2])('survives bilinear scaling ×%s (HiDPI, downscaled streams)', (factor) => {
    expect(findCanary(scale(frameWithCanary(), factor), SEQ).found).toBe(true);
  });

  it('survives per-channel noise of ±25', () => {
    expect(findCanary(addNoise(frameWithCanary(), 25, 9), SEQ).found).toBe(true);
  });

  it('survives a warm colour shift (blue × 0.65, roughly Night Color at 4500K)', () => {
    expect(findCanary(warmShift(frameWithCanary(), 0.65), SEQ).found).toBe(true);
  });

  it('reads BGRA buffers (Electron nativeImage.toBitmap)', () => {
    expect(findCanary(toBgra(frameWithCanary()), SEQ).found).toBe(true);
  });

  it('finds a small canary (6 px stripes, 12 px tall)', () => {
    const f = noisyFrame(400, 200, 3);
    drawCanary(f, SEQ, 10, 50, 6, 12);
    expect(findCanary(f, SEQ).found).toBe(true);
  });
});

describe('findCanary — negatives (the cases a pass depends on)', () => {
  it('does not find a canary in a busy frame without one', () => {
    for (let seed = 1; seed <= 25; seed++) expect(findCanary(noisyFrame(800, 500, seed), SEQ).found).toBe(false);
  });

  it('does not confuse a different sequence (the control canary) for the protected one', () => {
    const f = noisyFrame(800, 500, 4);
    drawCanary(f, OTHER, 100, 100, 24, 120);
    expect(findCanary(f, SEQ).found).toBe(false);
    expect(findCanary(f, OTHER).found).toBe(true);
  });

  it('does not find a canary hidden under a black box (Hyprland-style exclusion)', () => {
    const f = frameWithCanary();
    fillRect(f, 100, 180, 400, 200, [0, 0, 0]);
    expect(findCanary(f, SEQ).found).toBe(false);
  });

  it('does not find a canary that is only partly visible (cut off mid-sequence)', () => {
    const f = frameWithCanary();
    fillRect(f, 137 + 24 * 6, 0, 800, 500, [17, 19, 24]);
    expect(findCanary(f, SEQ).found).toBe(false);
  });

  it('does not find a canary in a flat empty frame', () => {
    expect(findCanary(blankFrame(640, 360), SEQ).found).toBe(false);
  });

  it('rejects a truncated buffer instead of reading out of bounds', () => {
    expect(() => findCanary({ data: new Uint8Array(10), width: 100, height: 100, order: 'rgba' }, SEQ)).toThrow();
  });
});
