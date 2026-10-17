/**
 * Interleaves two mono s16le streams (left = microphone, right = call audio) into one
 * stereo s16le stream, so whisper's channel diarization (-di) can tell "You" from "Them".
 *
 * The two recorders deliver bytes on their own schedules, so frames are emitted only when both
 * sides have samples — normal delivery jitter just waits. A suspended PipeWire sink sends nothing
 * at all while silent, so a side that has delivered nothing for `staleMs` (or has fallen a full
 * `maxLagBytes` behind) is treated as silent and padded, instead of stalling the transcript.
 * Padding on mere jitter would shift one channel against the other for good, hence the time test.
 * Pure (no I/O; injectable clock), so it is unit-tested directly.
 */
export class StereoMixer {
  private left = Buffer.alloc(0);
  private right = Buffer.alloc(0);
  private lastLeft: number;
  private lastRight: number;

  constructor(
    private readonly opts: { staleMs?: number; maxLagBytes?: number; now?: () => number } = {},
  ) {
    const t = this.now();
    this.lastLeft = t;
    this.lastRight = t;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  pushLeft(bytes: Uint8Array): Uint8Array {
    this.left = Buffer.concat([this.left, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    this.lastLeft = this.now();
    return this.drain();
  }

  pushRight(bytes: Uint8Array): Uint8Array {
    this.right = Buffer.concat([this.right, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    this.lastRight = this.now();
    return this.drain();
  }

  private drain(): Uint8Array {
    const now = this.now();
    const stale = this.opts.staleMs ?? 300;
    const maxLag = this.opts.maxLagBytes ?? 32_000; // 1s at 16 kHz mono s16le
    // Pad a side that has gone quiet (suspended sink / muted mic) so the other keeps flowing.
    if (this.left.length === 0 && this.right.length > 0 && (now - this.lastLeft >= stale || this.right.length >= maxLag)) this.left = Buffer.alloc(this.right.length);
    if (this.right.length === 0 && this.left.length > 0 && (now - this.lastRight >= stale || this.left.length >= maxLag)) this.right = Buffer.alloc(this.left.length);
    let n = Math.min(this.left.length, this.right.length);
    n -= n % 2; // whole 16-bit samples only
    if (n === 0) return new Uint8Array(0);
    const out = Buffer.alloc(n * 2);
    for (let i = 0, o = 0; i < n; i += 2, o += 4) {
      out[o] = this.left[i]!;
      out[o + 1] = this.left[i + 1]!;
      out[o + 2] = this.right[i]!;
      out[o + 3] = this.right[i + 1]!;
    }
    this.left = this.left.subarray(n);
    this.right = this.right.subarray(n);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
}
