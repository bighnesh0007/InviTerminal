import type { BrowserWindow } from 'electron';
import type { ProviderId } from '../../shared/protection';

export interface ProbeResult {
  supported: boolean;
  reason: string;
  knownGaps: string[];
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

export interface ReadbackResult {
  /** 'unknown' when the platform offers no way to read the flag back. */
  excluded: boolean | 'unknown';
  detail: string;
}

/**
 * One implementation per platform mechanism. A successful `apply` is only a
 * request; the controller always follows it with `readBack`, and only the
 * self-test says anything about what a capture actually contains.
 */
export interface CaptureExclusionProvider {
  readonly id: ProviderId;
  probe(win: BrowserWindow): Promise<ProbeResult>;
  apply(win: BrowserWindow, exclude: boolean): Promise<ApplyResult>;
  readBack(win: BrowserWindow): Promise<ReadbackResult>;
}
