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
  termProfiles: 'term:profiles',
  termSpawn: 'term:spawn',
  termInput: 'term:input',
  termResize: 'term:resize',
  termAck: 'term:ack',
  termKill: 'term:kill',
  /** main → renderer */
  termData: 'term:data',
  /** main → renderer */
  termExit: 'term:exit',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
} as const;

export interface ShellProfileInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface TermSession {
  sessionId: string;
  profileId: string;
  label: string;
  pid: number;
}

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

  terminal: {
    profiles(): Promise<ShellProfileInfo[]>;
    spawn(profileId?: string): Promise<TermSession>;
    input(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    ack(sessionId: string, chars: number): void;
    kill(sessionId: string): void;
    onData(cb: (sessionId: string, data: string) => void): void;
    onExit(cb: (sessionId: string, exitCode: number, signal: number | null) => void): void;
  };
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
}
