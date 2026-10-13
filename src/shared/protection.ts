import type { Verdict } from './selftest-verdict';

export type ProviderId = 'kwin' | 'unsupported';

/**
 * Ordered by strength of evidence. Nothing below `selftest-passed` says
 * anything about pixels; `readback-confirmed` only means the compositor
 * reports the flag as set.
 */
export type ProtectionLevel =
  | 'unsupported'
  | 'unprotected'
  | 'request-failed'
  | 'requested'
  | 'readback-confirmed'
  | 'selftest-passed'
  | 'selftest-failed';

export type SelfTestPath = 'kwin-screenshot' | 'portal-screencast';

export interface SelfTestRecord {
  path: SelfTestPath;
  verdict: Verdict;
  reason: string;
  /** ISO timestamp. */
  at: string;
  detail: string;
}

export interface ProtectionState {
  provider: ProviderId;
  level: ProtectionLevel;
  detail: string;
  /** ISO timestamp of the last apply; self-tests older than this are stale. */
  appliedAt: string | null;
  knownGaps: string[];
  selfTests: SelfTestRecord[];
}

/** Whether sensitive content may be shown without the user overriding. */
export function contentMayShow(level: ProtectionLevel): boolean {
  return level === 'readback-confirmed' || level === 'selftest-passed';
}
