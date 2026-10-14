import { describe, expect, it } from 'vitest';
import { encodeWav, isWav, resample, WHISPER_SAMPLE_RATE } from '../src/shared/wav';

function readWavHeader(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { channels: v.getUint16(22, true), rate: v.getUint32(24, true), bits: v.getUint16(34, true), dataLen: v.getUint32(40, true) };
}

describe('resample', () => {
  it('returns the input unchanged at equal rates', () => {
    const x = new Float32Array([0, 0.5, -0.5, 1]);
    expect(resample(x, 16000, 16000)).toBe(x);
  });
  it('downsamples 48k → 16k to a third of the length', () => {
    const x = new Float32Array(48000).map((_, i) => Math.sin((i / 48000) * 440 * 2 * Math.PI));
    const out = resample(x, 48000, 16000);
    expect(out.length).toBe(16000);
  });
  it('rejects non-positive rates', () => {
    expect(() => resample(new Float32Array(10), 0, 16000)).toThrow();
  });
});

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono 16-bit WAV header', () => {
    const wav = encodeWav(new Float32Array(48000).fill(0), 48000);
    expect(isWav(wav)).toBe(true);
    const h = readWavHeader(wav);
    expect(h).toMatchObject({ channels: 1, rate: WHISPER_SAMPLE_RATE, bits: 16 });
    expect(h.dataLen).toBe(16000 * 2); // 1s at 48k → 16000 samples × 2 bytes
    expect(wav.length).toBe(44 + 16000 * 2);
  });

  it('clamps out-of-range samples instead of overflowing', () => {
    const wav = encodeWav(new Float32Array([2, -2, 1, -1]), 16000);
    const v = new DataView(wav.buffer);
    expect(v.getInt16(44, true)).toBe(0x7fff); // +2 clamped to +1 → max
    expect(v.getInt16(46, true)).toBe(-0x8000); // -2 clamped to -1 → min
  });

  it('encodes a recognizable sine tone (round-trips through PCM)', () => {
    const rate = 16000;
    const sine = new Float32Array(rate).map((_, i) => Math.sin((i / rate) * 1000 * 2 * Math.PI) * 0.5);
    const wav = encodeWav(sine, rate);
    const v = new DataView(wav.buffer);
    let peak = 0;
    for (let off = 44; off < wav.length; off += 2) peak = Math.max(peak, Math.abs(v.getInt16(off, true)));
    expect(peak).toBeGreaterThan(0x3000); // ~0.5 amplitude
    expect(peak).toBeLessThanOrEqual(0x7fff);
  });
});

describe('isWav', () => {
  it('rejects non-wav and short buffers', () => {
    expect(isWav(new Uint8Array(10))).toBe(false);
    expect(isWav(new TextEncoder().encode('not a wav file at all, just text here padded....'))).toBe(false);
  });
});
