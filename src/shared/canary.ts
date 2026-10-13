/**
 * A canary is a row of solid, fully saturated stripes whose colour order is
 * random per test. Finding that exact order in a captured frame means the
 * window was captured; a stale frame or a different window cannot match by
 * accident (6 * 5^11 ≈ 2.9e8 possible orders).
 *
 * Shared by the renderer (draws it), the main process (scans screenshots)
 * and the tests (synthesise frames), so all three agree by construction.
 */

/** Each colour is a distinct pattern of channels at 0 or 255, so classification is a per-channel threshold. */
export const PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [0, 255, 255],
  [255, 0, 255],
  [255, 255, 0],
];

export const STRIPE_COUNT = 12;

export type CanarySequence = readonly number[];

/** Adjacent stripes always differ, otherwise two stripes would read as one wide stripe. */
export function sequenceFromBytes(bytes: Uint8Array): CanarySequence {
  if (bytes.length < STRIPE_COUNT) throw new Error(`need ${STRIPE_COUNT} random bytes, got ${bytes.length}`);
  const seq: number[] = [];
  for (let i = 0; i < STRIPE_COUNT; i++) {
    const b = bytes[i]!;
    seq.push(i === 0 ? b % PALETTE.length : (seq[i - 1]! + 1 + (b % (PALETTE.length - 1))) % PALETTE.length);
  }
  return seq;
}

export function randomSequence(): CanarySequence {
  return sequenceFromBytes(crypto.getRandomValues(new Uint8Array(STRIPE_COUNT)));
}

export function isValidSequence(seq: readonly number[]): boolean {
  return (
    seq.length === STRIPE_COUNT &&
    seq.every((c, i) => Number.isInteger(c) && c >= 0 && c < PALETTE.length && (i === 0 || c !== seq[i - 1]))
  );
}

export function cssColor(index: number): string {
  const [r, g, b] = PALETTE[index]!;
  return `rgb(${r}, ${g}, ${b})`;
}
