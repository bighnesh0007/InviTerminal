import { describe, expect, it } from 'vitest';
import { STRIPE_COUNT, isValidSequence, randomSequence, sequenceFromBytes } from '../src/shared/canary';

describe('canary sequence', () => {
  it('never repeats a colour in adjacent stripes, for every byte value', () => {
    for (let b = 0; b < 256; b++) {
      const seq = sequenceFromBytes(new Uint8Array(STRIPE_COUNT).fill(b));
      expect(isValidSequence(seq)).toBe(true);
    }
  });

  it('produces valid random sequences', () => {
    for (let i = 0; i < 500; i++) expect(isValidSequence(randomSequence())).toBe(true);
  });

  it('rejects malformed sequences', () => {
    expect(isValidSequence([0, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4])).toBe(false);
    expect(isValidSequence([0, 1])).toBe(false);
    expect(isValidSequence([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 6])).toBe(false);
  });

  it('refuses too few random bytes', () => {
    expect(() => sequenceFromBytes(new Uint8Array(3))).toThrow();
  });
});
