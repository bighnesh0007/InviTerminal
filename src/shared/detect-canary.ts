import { PALETTE, type CanarySequence } from './canary';

export interface Frame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Byte order of each 4-byte pixel. Canvas ImageData is RGBA; Electron's nativeImage.toBitmap() is BGRA. */
  order: 'rgba' | 'bgra';
}

export interface DetectOptions {
  /** Scan every Nth row. */
  rowStep: number;
  /** A channel within this distance of 0 or 255 counts as low/high. Wide enough to survive Night Color and lossy encoders. */
  tolerance: number;
  /** Narrowest stripe accepted, in frame pixels. */
  minStripePx: number;
  /** Widest blended/unclassified gap allowed between two stripes (scaling and chroma subsampling blur edges). */
  maxGapPx: number;
  /** Interior stripes may differ from their median width by at most this fraction. */
  widthTolerance: number;
  /** Matching rows required before reporting a find. */
  minRows: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  rowStep: 2,
  tolerance: 100,
  minStripePx: 3,
  maxGapPx: 3,
  widthTolerance: 0.35,
  minRows: 3,
};

export interface DetectResult {
  found: boolean;
  matchingRows: number;
  firstMatch?: { x: number; y: number; stripePx: number };
}

interface Run {
  cls: number;
  start: number;
  len: number;
}

/** Channel bit pattern (r<<2 | g<<1 | b) → palette index, or -1 for black/white/unknown. */
const BITS_TO_INDEX: readonly number[] = (() => {
  const table = new Array<number>(8).fill(-1);
  PALETTE.forEach(([r, g, b], i) => {
    table[(r ? 4 : 0) | (g ? 2 : 0) | (b ? 1 : 0)] = i;
  });
  return table;
})();

function classify(r: number, g: number, b: number, tol: number): number {
  const hi = 255 - tol;
  let bits = 0;
  for (const [v, bit] of [
    [r, 4],
    [g, 2],
    [b, 1],
  ] as const) {
    if (v >= hi) bits |= bit;
    else if (v > tol) return -1;
  }
  return BITS_TO_INDEX[bits]!;
}

function rowRuns(frame: Frame, y: number, tol: number): Run[] {
  const { data, width, order } = frame;
  const rOff = order === 'rgba' ? 0 : 2;
  const bOff = order === 'rgba' ? 2 : 0;
  const runs: Run[] = [];
  let base = y * width * 4;
  for (let x = 0; x < width; x++, base += 4) {
    const cls = classify(data[base + rOff]!, data[base + 1]!, data[base + bOff]!, tol);
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.len++;
    else runs.push({ cls, start: x, len: 1 });
  }
  return runs;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function matchAt(runs: Run[], k: number, seq: CanarySequence, o: DetectOptions): { x: number; stripePx: number } | null {
  const widths: number[] = [];
  let i = k;
  for (let j = 0; j < seq.length; j++) {
    if (j > 0) {
      // Skip one short blended gap between stripes.
      const gap = runs[i];
      if (gap && gap.cls === -1 && gap.len <= o.maxGapPx) i++;
    }
    const run = runs[i];
    if (!run || run.cls !== seq[j] || run.len < o.minStripePx) return null;
    widths.push(run.len);
    i++;
  }
  // First and last stripes may merge with a same-coloured background, so only interior widths are compared.
  const interior = widths.slice(1, -1);
  const m = median(interior);
  if (!interior.every((w) => Math.abs(w - m) <= m * o.widthTolerance + 1)) return null;
  const last = widths[widths.length - 1]!;
  if (widths[0]! < m * (1 - o.widthTolerance) || last < m * (1 - o.widthTolerance)) return null;
  return { x: runs[k]!.start + Math.max(0, runs[k]!.len - m), stripePx: m };
}

export function findCanary(frame: Frame, seq: CanarySequence, opts: Partial<DetectOptions> = {}): DetectResult {
  const o = { ...DEFAULT_DETECT_OPTIONS, ...opts };
  if (frame.data.length < frame.width * frame.height * 4) throw new Error('frame buffer smaller than width*height*4');
  let matchingRows = 0;
  let firstMatch: DetectResult['firstMatch'];
  for (let y = 0; y < frame.height; y += o.rowStep) {
    const runs = rowRuns(frame, y, o.tolerance);
    for (let k = 0; k < runs.length; k++) {
      if (runs[k]!.cls !== seq[0]) continue;
      const hit = matchAt(runs, k, seq, o);
      if (hit) {
        matchingRows++;
        firstMatch ??= { x: hit.x, y, stripePx: hit.stripePx };
        break;
      }
    }
  }
  const found = matchingRows >= o.minRows;
  return found && firstMatch ? { found, matchingRows, firstMatch } : { found, matchingRows };
}
