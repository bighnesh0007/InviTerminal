import { PALETTE, type CanarySequence } from '../../src/shared/canary';
import type { Frame } from '../../src/shared/detect-canary';

/** Deterministic PRNG so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function blankFrame(width: number, height: number, rgb: [number, number, number] = [17, 19, 24]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return { data, width, height, order: 'rgba' };
}

/** Busy desktop-like background: random blocks of arbitrary colour, including exact palette colours. */
export function noisyFrame(width: number, height: number, seed: number): Frame {
  const f = blankFrame(width, height);
  const r = rng(seed);
  for (let n = 0; n < 400; n++) {
    const usePalette = r() < 0.5;
    const colour = usePalette
      ? PALETTE[Math.floor(r() * PALETTE.length)]!
      : ([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)] as const);
    fillRect(f, Math.floor(r() * width), Math.floor(r() * height), 4 + Math.floor(r() * 60), 2 + Math.floor(r() * 30), colour);
  }
  return f;
}

export function fillRect(f: Frame, x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let y = Math.max(0, y0); y < Math.min(f.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(f.width, x0 + w); x++) {
      const i = (y * f.width + x) * 4;
      f.data[i] = rgb[0];
      f.data[i + 1] = rgb[1];
      f.data[i + 2] = rgb[2];
    }
  }
}

/** Draws the canary exactly as the renderer lays it out: equal-width stripes, left to right. */
export function drawCanary(f: Frame, seq: CanarySequence, x: number, y: number, stripePx: number, height: number): void {
  seq.forEach((c, i) => fillRect(f, x + i * stripePx, y, stripePx, height, PALETTE[c]!));
}

/** Bilinear resample, which blends stripe edges the way compositor/encoder scaling does. */
export function scale(f: Frame, factor: number): Frame {
  const w = Math.round(f.width * factor);
  const h = Math.round(f.height * factor);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(f.height - 1.001, (y + 0.5) / factor - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(f.width - 1.001, (x + 0.5) / factor - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const fx = Math.max(0, sx - x0);
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) => f.data[(yy * f.width + xx) * 4 + c]!;
        const top = p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx;
        const bot = p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx;
        out[(y * w + x) * 4 + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { data: out, width: w, height: h, order: f.order };
}

export function addNoise(f: Frame, amplitude: number, seed: number): Frame {
  const r = rng(seed);
  const data = new Uint8ClampedArray(f.data);
  for (let i = 0; i < data.length; i++) {
    if (i % 4 !== 3) data[i] = data[i]! + Math.round((r() * 2 - 1) * amplitude);
  }
  return { ...f, data };
}

/** Simulates Night Color / a warm colour profile by scaling the blue channel. */
export function warmShift(f: Frame, blueFactor: number): Frame {
  const data = new Uint8ClampedArray(f.data);
  for (let i = 2; i < data.length; i += 4) data[i] = data[i]! * blueFactor;
  return { ...f, data };
}

export function toBgra(f: Frame): Frame {
  const data = new Uint8ClampedArray(f.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = f.data[i + 2]!;
    data[i + 2] = f.data[i]!;
  }
  return { ...f, data, order: 'bgra' };
}
