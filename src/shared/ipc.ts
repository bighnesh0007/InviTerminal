import type { CanarySequence } from './canary';
import type { ProtectionState, SelfTestRecord } from './protection';

export const IPC = {
  getState: 'protection:get-state',
  state: 'protection:state',
  protect: 'protection:protect',
  unprotect: 'protection:unprotect',
  recheck: 'protection:recheck',
  selfTestScreenshot: 'selftest:screenshot',
  selfTestScreencastPrepare: 'selftest:screencast-prepare',
  selfTestScreencastReport: 'selftest:screencast-report',
  /** main → renderer: draw this canary, or clear it (null). */
  canary: 'canary:show',
  /** renderer → main: the canary requested last has been painted. */
  canaryPainted: 'canary:painted',
} as const;

export interface ScreencastPrepared {
  protectedSeq: CanarySequence;
  controlSeq: CanarySequence;
}

export interface ScreencastReport {
  protectedFound: boolean;
  controlFound: boolean;
  width: number;
  height: number;
  frames: number;
  error?: string;
}

/** What the preload exposes as `window.inviterminal`. */
export interface RendererApi {
  getState(): Promise<ProtectionState>;
  onState(cb: (s: ProtectionState) => void): void;
  protect(): Promise<void>;
  unprotect(): Promise<void>;
  recheck(): Promise<void>;
  runScreenshotSelfTest(): Promise<SelfTestRecord>;
  prepareScreencastSelfTest(): Promise<ScreencastPrepared>;
  reportScreencastSelfTest(r: ScreencastReport): Promise<SelfTestRecord>;
  onCanary(cb: (seq: CanarySequence | null) => void): void;
  canaryPainted(): void;
}
