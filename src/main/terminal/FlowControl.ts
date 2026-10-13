/**
 * Stops a fast producer (`cat bigfile`, `yes`) from flooding IPC and the
 * renderer. The renderer acknowledges characters once xterm.js has parsed
 * them; the PTY is paused while too many are in flight. Same scheme as VS
 * Code's terminal.
 */
export class FlowControl {
  private unacked = 0;
  private paused = false;
  pauseCount = 0;

  constructor(
    private readonly onPause: () => void,
    private readonly onResume: () => void,
    private readonly highWatermark = 100_000,
    private readonly lowWatermark = 10_000,
  ) {
    if (lowWatermark >= highWatermark) throw new Error('lowWatermark must be below highWatermark');
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get inFlight(): number {
    return this.unacked;
  }

  sent(chars: number): void {
    this.unacked += chars;
    if (!this.paused && this.unacked > this.highWatermark) {
      this.paused = true;
      this.pauseCount++;
      this.onPause();
    }
  }

  acked(chars: number): void {
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused && this.unacked < this.lowWatermark) {
      this.paused = false;
      this.onResume();
    }
  }
}
