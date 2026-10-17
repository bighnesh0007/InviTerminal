import { contextBridge, ipcRenderer } from 'electron';
import type { CanarySequence } from '../shared/canary';
import { type ConcealRequest, IPC, type RendererApi, type ScreencastReport } from '../shared/ipc';
import type { ProtectionState } from '../shared/protection';
import type { AiStatus } from '../shared/ai';
import type { AudioStatus } from '../shared/audio';
import type { CompanionStatus } from '../shared/companion';
import type { SettingsView } from '../shared/settings';
import type { LibraryStatus } from '../shared/snippet';

// Each function maps to exactly one channel; the renderer never sees ipcRenderer itself.
const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb) => {
    ipcRenderer.on(IPC.state, (_e, s: ProtectionState) => cb(s));
  },
  protect: () => ipcRenderer.invoke(IPC.protect),
  unprotect: () => ipcRenderer.invoke(IPC.unprotect),
  recheck: () => ipcRenderer.invoke(IPC.recheck),
  runScreenshotSelfTest: () => ipcRenderer.invoke(IPC.selfTestScreenshot),
  prepareScreencastSelfTest: () => ipcRenderer.invoke(IPC.selfTestScreencastPrepare),
  reportScreencastSelfTest: (r: ScreencastReport) => ipcRenderer.invoke(IPC.selfTestScreencastReport, r),
  onCanary: (cb) => {
    ipcRenderer.on(IPC.canary, (_e, seq: CanarySequence | null) => cb(seq));
  },
  canaryPainted: () => ipcRenderer.send(IPC.canaryPainted),

  terminal: {
    profiles: () => ipcRenderer.invoke(IPC.termProfiles),
    spawn: (profileId) => ipcRenderer.invoke(IPC.termSpawn, profileId === undefined ? {} : { profileId }),
    input: (sessionId, data) => ipcRenderer.send(IPC.termInput, { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.termResize, { sessionId, cols, rows }),
    ack: (sessionId, chars) => ipcRenderer.send(IPC.termAck, { sessionId, chars }),
    kill: (sessionId) => ipcRenderer.send(IPC.termKill, { sessionId }),
    onData: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, sessionId: string, data: string) => cb(sessionId, data);
      ipcRenderer.on(IPC.termData, l);
      return () => void ipcRenderer.removeListener(IPC.termData, l);
    },
    onExit: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, sessionId: string, exitCode: number, signal: number | null) => cb(sessionId, exitCode, signal);
      ipcRenderer.on(IPC.termExit, l);
      return () => void ipcRenderer.removeListener(IPC.termExit, l);
    },
  },
  clipboard: {
    read: () => ipcRenderer.invoke(IPC.clipboardRead),
    write: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text }),
  },
  visibility: {
    onConceal: (cb) => {
      ipcRenderer.on(IPC.conceal, (_e, req: ConcealRequest) => cb(req));
    },
    concealed: (token) => ipcRenderer.send(IPC.concealed, token),
    panicHide: () => ipcRenderer.send(IPC.panicHide),
  },
  library: {
    status: () => ipcRenderer.invoke(IPC.libStatus),
    onStatus: (cb) => {
      ipcRenderer.on(IPC.libStatusChanged, (_e, s: LibraryStatus) => cb(s));
    },
    retry: () => ipcRenderer.invoke(IPC.libRetry),
    search: (q) => ipcRenderer.invoke(IPC.libSearch, q),
    create: (input) => ipcRenderer.invoke(IPC.libCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.libUpdate, { id, patch }),
    trash: (id) => ipcRenderer.invoke(IPC.libTrash, { id }),
    restore: (id) => ipcRenderer.invoke(IPC.libRestore, { id }),
    used: (id) => ipcRenderer.invoke(IPC.libUsed, { id }),
    folders: () => ipcRenderer.invoke(IPC.libFolders),
    tags: () => ipcRenderer.invoke(IPC.libTags),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChange: (cb) => {
      ipcRenderer.on(IPC.settingsChanged, (_e, v: SettingsView) => cb(v));
    },
  },
  ai: {
    status: () => ipcRenderer.invoke(IPC.aiStatus),
    onStatus: (cb) => {
      ipcRenderer.on(IPC.aiStatusChanged, (_e, s: AiStatus) => cb(s));
    },
    setKey: (key) => ipcRenderer.invoke(IPC.aiSetKey, { key }),
    clearKey: () => ipcRenderer.invoke(IPC.aiClearKey),
    testKey: () => ipcRenderer.invoke(IPC.aiTestKey),
    explain: (req) => ipcRenderer.invoke(IPC.aiExplainStart, req),
    cancelExplain: () => ipcRenderer.send(IPC.aiExplainCancel),
    onExplainDelta: (cb) => {
      ipcRenderer.on(IPC.aiExplainDelta, (_e, chunk: string) => cb(chunk));
    },
    onExplainDone: (cb) => {
      ipcRenderer.on(IPC.aiExplainDone, (_e, full: string) => cb(full));
    },
    onExplainError: (cb) => {
      ipcRenderer.on(IPC.aiExplainError, (_e, m: string) => cb(m));
    },
    onExplainCancelled: (cb) => {
      ipcRenderer.on(IPC.aiExplainCancelled, (_e, m: string) => cb(m));
    },
  },
  audio: {
    status: () => ipcRenderer.invoke(IPC.audioStatus),
    onStatus: (cb) => {
      ipcRenderer.on(IPC.audioStatusChanged, (_e, s: AudioStatus) => cb(s));
    },
    start: (kind) => ipcRenderer.invoke(IPC.audioStart, { kind }),
    stop: () => ipcRenderer.invoke(IPC.audioStop),
    consentToMeeting: () => ipcRenderer.invoke(IPC.audioConsentMeeting),
  },
  stt: {
    status: () => ipcRenderer.invoke(IPC.sttStatus),
    transcribe: (wav) => ipcRenderer.invoke(IPC.sttTranscribe, { wav }),
  },
  tts: {
    status: () => ipcRenderer.invoke(IPC.ttsStatus),
    speak: (text) => ipcRenderer.invoke(IPC.ttsSpeak, { text }),
    stop: () => ipcRenderer.send(IPC.ttsStop),
  },
  live: {
    status: () => ipcRenderer.invoke(IPC.liveStatus),
    start: (consent, mode) => ipcRenderer.invoke(IPC.liveStart, mode ? { consent, mode } : { consent }),
    stop: () => ipcRenderer.invoke(IPC.liveStop),
    pause: () => ipcRenderer.invoke(IPC.livePause),
    resume: () => ipcRenderer.invoke(IPC.liveResume),
    exportMarkdown: (markdown, suggestedName) => ipcRenderer.invoke(IPC.liveExport, { markdown, suggestedName }),
    clear: () => ipcRenderer.invoke(IPC.liveClear),
    onStatus: (cb) => {
      ipcRenderer.on(IPC.liveStatusChanged, (_e, s) => cb(s));
    },
    onLine: (cb) => {
      ipcRenderer.on(IPC.liveLine, (_e, l) => cb(l));
    },
    onError: (cb) => {
      ipcRenderer.on(IPC.liveError, (_e, m: string) => cb(m));
    },
    ask: (id, text, length, opts) => ipcRenderer.invoke(IPC.liveAsk, { id, text, length, ...(opts?.history ? { history: opts.history } : {}), ...(opts?.mode ? { mode: opts.mode } : {}) }),
    cancelAsk: () => ipcRenderer.send(IPC.liveAskCancel),
    onAnswerDelta: (cb) => {
      ipcRenderer.on(IPC.liveAnswerDelta, (_e, m) => cb(m));
    },
    onAnswerDone: (cb) => {
      ipcRenderer.on(IPC.liveAnswerDone, (_e, m) => cb(m));
    },
    onAnswerError: (cb) => {
      ipcRenderer.on(IPC.liveAnswerError, (_e, m) => cb(m));
    },
  },
  companion: {
    status: () => ipcRenderer.invoke(IPC.companionStatus),
    onStatus: (cb) => {
      ipcRenderer.on(IPC.companionStatusChanged, (_e, s: CompanionStatus) => cb(s));
    },
    start: () => ipcRenderer.invoke(IPC.companionStart),
    stop: () => ipcRenderer.invoke(IPC.companionStop),
    forget: () => ipcRenderer.invoke(IPC.companionForget),
  },
  usage: {
    // Fire-and-forget: a tracking call must never throw into the caller's code path.
    track: (action) => {
      try {
        ipcRenderer.send(IPC.usageTrack, { action });
      } catch {
        /* ignore */
      }
    },
    get: () => ipcRenderer.invoke(IPC.usageGet),
    reset: () => ipcRenderer.invoke(IPC.usageReset),
    export: () => ipcRenderer.invoke(IPC.usageExport),
  },
  practice: {
    start: (topic) => ipcRenderer.invoke(IPC.practiceStart, { topic }),
    answer: (answer) => ipcRenderer.invoke(IPC.practiceAnswer, { answer }),
    cancel: () => ipcRenderer.send(IPC.practiceCancel),
    end: () => ipcRenderer.invoke(IPC.practiceEnd),
    onDelta: (cb) => {
      ipcRenderer.on(IPC.practiceDelta, (_e, c: string) => cb(c));
    },
    onTurn: (cb) => {
      ipcRenderer.on(IPC.practiceTurn, (_e, f: string) => cb(f));
    },
    onError: (cb) => {
      ipcRenderer.on(IPC.practiceError, (_e, m: string) => cb(m));
    },
  },
};

contextBridge.exposeInMainWorld('inviterminal', api);
