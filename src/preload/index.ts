import { contextBridge, ipcRenderer } from 'electron';
import type { CanarySequence } from '../shared/canary';
import { type ConcealRequest, IPC, type RendererApi, type ScreencastReport } from '../shared/ipc';
import type { ProtectionState } from '../shared/protection';
import type { AiStatus } from '../shared/ai';
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
  },
};

contextBridge.exposeInMainWorld('inviterminal', api);
