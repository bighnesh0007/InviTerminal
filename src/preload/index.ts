import { contextBridge, ipcRenderer } from 'electron';
import type { CanarySequence } from '../shared/canary';
import { IPC, type RendererApi, type ScreencastReport } from '../shared/ipc';
import type { ProtectionState } from '../shared/protection';

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
};

contextBridge.exposeInMainWorld('inviterminal', api);
