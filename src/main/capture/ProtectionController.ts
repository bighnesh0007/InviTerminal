import type { BrowserWindow } from 'electron';
import type { ProtectionLevel, ProtectionState, SelfTestRecord } from '../../shared/protection';
import type { CaptureExclusionProvider } from './types';

/** Levels at which a self-test result is meaningful evidence about protection. */
const PROTECTED_LEVELS: readonly ProtectionLevel[] = ['requested', 'readback-confirmed', 'selftest-passed', 'selftest-failed'];

const MAX_SELFTEST_HISTORY = 20;

export class ProtectionController {
  private state: ProtectionState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly provider: CaptureExclusionProvider,
    private readonly win: BrowserWindow,
    private readonly onChange: (s: ProtectionState) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = { provider: provider.id, level: 'unprotected', detail: 'Not applied yet.', appliedAt: null, knownGaps: [], selfTests: [] };
  }

  get(): ProtectionState {
    return structuredClone(this.state);
  }

  /** Serialises operations so a periodic recheck cannot interleave with an apply. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private set(patch: Partial<ProtectionState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.get());
  }

  initialise(): Promise<void> {
    return this.run(async () => {
      const probe = await this.provider.probe(this.win);
      this.set({ knownGaps: probe.knownGaps });
      if (!probe.supported) {
        this.set({ level: 'unsupported', detail: probe.reason });
        return;
      }
      await this.applyLocked(true);
    });
  }

  protect(): Promise<void> {
    return this.run(() => this.applyLocked(true));
  }

  unprotect(): Promise<void> {
    return this.run(() => this.applyLocked(false));
  }

  private async applyLocked(exclude: boolean): Promise<void> {
    if (this.state.level === 'unsupported') return;
    if (exclude) this.set({ level: 'requested', detail: 'Requesting exclusion from capture…' });
    const res = await this.provider.apply(this.win, exclude);
    if (!res.ok) {
      this.set({ level: exclude ? 'request-failed' : this.state.level, detail: `Request failed: ${res.error ?? 'unknown error'}` });
      return;
    }
    const rb = await this.provider.readBack(this.win);
    if (!exclude) {
      this.set({
        level: 'unprotected',
        appliedAt: null,
        detail: rb.excluded === false ? `Protection removed. ${rb.detail}` : `Asked to remove protection but readback says: ${rb.detail}`,
      });
      return;
    }
    if (rb.excluded === true) {
      this.set({ level: 'readback-confirmed', appliedAt: this.now().toISOString(), detail: rb.detail });
    } else if (rb.excluded === false) {
      this.set({ level: 'request-failed', detail: `The request reported success but readback says the flag is off. ${rb.detail}` });
    } else {
      this.set({ level: 'requested', appliedAt: this.now().toISOString(), detail: `Requested, but it could not be read back. ${rb.detail}` });
    }
  }

  /** Re-reads the flag without changing it, e.g. if the user toggled it from the KWin titlebar menu. */
  recheck(): Promise<void> {
    return this.run(async () => {
      if (this.state.level === 'unsupported') return;
      const rb = await this.provider.readBack(this.win);
      const wasProtected = PROTECTED_LEVELS.includes(this.state.level);
      if (rb.excluded === false && wasProtected) {
        this.set({ level: 'unprotected', appliedAt: null, detail: `The compositor no longer reports this window as excluded. ${rb.detail}` });
      } else if (rb.excluded === true && !wasProtected) {
        this.set({ level: 'readback-confirmed', appliedAt: this.now().toISOString(), detail: `Exclusion was turned on outside the app. ${rb.detail}` });
      } else if (rb.excluded === 'unknown' && (this.state.level === 'readback-confirmed' || this.state.level === 'selftest-passed')) {
        this.set({ level: 'requested', detail: `Could not re-read the flag. ${rb.detail}` });
      }
    });
  }

  recordSelfTest(rec: SelfTestRecord): void {
    const selfTests = [rec, ...this.state.selfTests].slice(0, MAX_SELFTEST_HISTORY);
    if (!PROTECTED_LEVELS.includes(this.state.level)) {
      // A test while unprotected is a useful negative control, but it is not evidence about protection.
      this.set({ selfTests });
      return;
    }
    if (rec.verdict === 'fail') {
      this.set({ selfTests, level: 'selftest-failed', detail: `Self-test (${rec.path}) saw protected content: ${rec.reason}` });
    } else if (rec.verdict === 'pass' && this.state.level === 'readback-confirmed') {
      this.set({ selfTests, level: 'selftest-passed', detail: `Self-test (${rec.path}) passed at ${rec.at}. Only that capture path was tested.` });
    } else {
      this.set({ selfTests });
    }
  }
}
