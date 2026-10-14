/**
 * Encodes captured microphone PCM to a 16 kHz mono 16-bit WAV — the format
 * whisper.cpp wants. Pure (no browser/node APIs beyond typed arrays) so it is
 * unit-testable and runs identically in the renderer.
 */

export const WHISPER_SAMPLE_RATE = 16_000;

/** Linear-interpolation resample of mono float samples. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  if (inRate <= 0 || outRate <= 0) throw new Error('sample rates must be positive');
  const ratio = inRate / outRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** Float [-1,1] mono → 16 kHz mono 16-bit PCM WAV bytes. */
export function encodeWav(samples: Float32Array, inputRate: number, outputRate: number = WHISPER_SAMPLE_RATE): Uint8Array {
  const pcm = resample(samples, inputRate, outputRate);
  const bytesPerSample = 2;
  const dataLen = pcm.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outputRate, true);
  view.setUint32(28, outputRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/**
 * Wraps already-16-bit little-endian PCM (e.g. from parecord --format=s16le) in a WAV
 * header, without re-encoding. Used by the live-capture path where the recorder already
 * produces the right rate/format.
 */
export function wrapPcm16Wav(pcm: Uint8Array, rate: number = WHISPER_SAMPLE_RATE, channels: number = 1): Uint8Array {
  const dataLen = pcm.length;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  out.set(pcm, 44);
  return out;
}

/** Header check used before spawning whisper: RIFF/WAVE plus a 'data' chunk (which may follow other chunks). */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  const tag = (off: number, s: string) => s.split('').every((c, i) => bytes[off + i] === c.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE')) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 12;
  while (i + 8 <= bytes.length) {
    if (tag(i, 'data')) return true;
    const sz = v.getUint32(i + 4, true);
    i += 8 + sz + (sz & 1);
  }
  return false;
}
