import type { CanarySequence } from './canary';
import type { ProtectionState, SelfTestRecord } from './protection';
import type { LibraryStatus, SearchQuery, Snippet, SnippetInput } from './snippet';

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
  /** main → renderer: cover the content before the window is hidden. */
  conceal: 'visibility:conceal',
  /** renderer → main: the cover for that token has been painted. */
  concealed: 'visibility:concealed',
  /** renderer → main: hide now (Ctrl+Shift+H or the Hide button). */
  panicHide: 'visibility:panic-hide',
  libStatus: 'library:status',
  /** main → renderer */
  libStatusChanged: 'library:status-changed',
  libRetry: 'library:retry',
  libSearch: 'library:search',
  libCreate: 'library:create',
  libUpdate: 'library:update',
  libTrash: 'library:trash',
  libRestore: 'library:restore',
  libUsed: 'library:used',
  libFolders: 'library:folders',
  libTags: 'library:tags',
} as const;

export interface ConcealRequest {
  token: number;
  /** ISO time from the main process; content stays covered until protection is re-applied after it. */
  at: string;
}

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
  visibility: {
    onConceal(cb: (req: ConcealRequest) => void): void;
    concealed(token: number): void;
    panicHide(): void;
  };
  library: {
    status(): Promise<LibraryStatus>;
    onStatus(cb: (s: LibraryStatus) => void): void;
    retry(): Promise<LibraryStatus>;
    search(q: SearchQuery): Promise<Snippet[]>;
    create(input: SnippetInput): Promise<Snippet>;
    update(id: string, patch: Partial<SnippetInput>): Promise<Snippet>;
    trash(id: string): Promise<Snippet>;
    restore(id: string): Promise<Snippet>;
    used(id: string): Promise<void>;
    folders(): Promise<string[]>;
    tags(): Promise<string[]>;
  };
}
