/**
 * Splits a continuous stream of raw PCM bytes into fixed-size chunks. The live
 * capture writes s16le mono at a known rate; we accumulate until a chunk's worth
 * of audio is buffered, then hand it off (to be WAV-wrapped and transcribed).
 * Pure and synchronous, so it is unit-testable without a real recorder.
 */
export class PcmChunker {
  private buf: Uint8Array[] = [];
  private pending = 0;

  /** @param chunkBytes bytes per emitted chunk (e.g. seconds * rate * 2 for s16le mono). */
  constructor(private readonly chunkBytes: number) {
    if (chunkBytes <= 0) throw new Error('chunkBytes must be positive');
  }

  /** Add captured bytes; returns any whole chunks now complete (usually 0 or 1). */
  push(bytes: Uint8Array): Uint8Array[] {
    if (bytes.length === 0) return [];
    this.buf.push(bytes);
    this.pending += bytes.length;
    const out: Uint8Array[] = [];
    while (this.pending >= this.chunkBytes) {
      out.push(this.take(this.chunkBytes));
    }
    return out;
  }

  /** Any buffered audio shorter than a full chunk (returned on stop, or [] if empty). */
  flush(): Uint8Array[] {
    if (this.pending === 0) return [];
    return [this.take(this.pending)];
  }

  private take(n: number): Uint8Array {
    const joined = concat(this.buf, this.pending);
    const chunk = joined.subarray(0, n);
    const rest = joined.subarray(n);
    this.buf = rest.length ? [rest] : [];
    this.pending = rest.length;
    return chunk;
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
