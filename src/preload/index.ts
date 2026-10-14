import { contextBridge, ipcRenderer } from 'electron';
import type { CanarySequence } from '../shared/canary';
import { type ConcealRequest, IPC, type RendererApi, type ScreencastReport } from '../shared/ipc';
import type { ProtectionState } from '../shared/protection';
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
      ipcRenderer.on(IPC.termData, (_e, sessionId: string, data: string) => cb(sessionId, data));
    },
    onExit: (cb) => {
      ipcRenderer.on(IPC.termExit, (_e, sessionId: string, exitCode: number, signal: number | null) => cb(sessionId, exitCode, signal));
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
};

contextBridge.exposeInMainWorld('inviterminal', api);
