import './load-env'; // MUST be first: populate process.env from .env before config/key-store read it
import { app, type BrowserWindow, desktopCapturer, globalShortcut, ipcMain, type IpcMainInvokeEvent, powerMonitor, safeStorage, screen, session } from 'electron';
import * as nodePty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { IPC } from '../shared/ipc';
import { aiExplainAutotest, aiKeyAutotest, captureAutotest, companionAutotest, liveTranscriptAutotest, micGateAutotest, practiceAutotest, sttAutotest, ttsAutotest, createTerminalTap, libraryAutotest, settingsReadbackAutotest, tabsSettingsAutotest, portalShortcutAutotest, terminalAutotest, uiSnapshotAutotest, visibilityAutotest, type ShortcutStatus } from './autotest';
import { classifyEnvironment } from './capture/detect';
import { ProtectionController } from './capture/ProtectionController';
import { createKwinProvider } from './capture/providers/kwin';
import { createUnsupportedProvider } from './capture/providers/unsupported';
import { SelfTestRunner } from './capture/selftest/SelfTestRunner';
import { config, sessionEnv, settingsEnvOverrides, shellParentEnv } from './config';
import { SettingsStore } from './settings/SettingsStore';
import { SettingsPatchSchema } from './settings/schema';
import { detectWindowsShellProfiles } from './terminal/windows-shells';
import { isFromWindow } from './ipc-guard';
import { buildChildEnv } from './terminal/env';
import { PtyManager } from './terminal/PtyManager';
import { registerTerminalIpc } from './terminal/register';
import { detectShellProfiles } from './terminal/shells';
import { registerVisibility } from './visibility/register';
import { AudioController } from './audio/AudioController';
import { registerAudioIpc } from './audio/register';
import { WhisperStt } from './audio/WhisperStt';
import { registerSttIpc } from './audio/stt-register';
import { type RunTts, TtsSpeaker } from './audio/TtsSpeaker';
import { registerTtsIpc } from './audio/tts-register';
import { type CaptureProcess, defaultMonitorSource, LiveTranscriptController, parecordCapture, type StartCapture } from './audio/LiveTranscriptController';
import { registerLiveIpc } from './audio/live-register';
import { GroqClient } from './ai/GroqClient';
import { KeyStore } from './ai/key-store';
import { registerAiIpc } from './ai/register';
import { type ExplainStreamer, registerExplainIpc } from './ai/explain';
import { CompanionController } from './companion/controller';
import { type ChatStreamer, registerPracticeIpc } from './ai/practice';
import { type AnswerStreamer, registerLiveAnswerIpc } from './ai/live-answer';
import { LibraryService } from './library/LibraryService';
import { registerLibraryIpc } from './library/register';
import { isProductionBuild } from './build-mode';
import { createWindow } from './window';

const ScreencastReportSchema = z
  .object({
    protectedFound: z.boolean(),
    controlFound: z.boolean(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
    error: z.string().max(500).optional(),
  })
  .strict();

// A terminal running as root under a GUI is never what a user wants, and Chromium's sandbox refuses it anyway.
if (process.getuid?.() === 0) {
  console.error('InviTerminal refuses to run as root.');
  app.exit(1);
}

// Pinned so the data directory (~/.config/inviterminal), the single-instance lock and the
// Wayland app id stay the same however the app is launched or packaged.
app.setName('inviterminal');

// Must precede the single-instance lock and settings, which both live in the data directory.
if (config.userDataDir) app.setPath('userData', config.userDataDir);

if (!app.requestSingleInstanceLock()) app.exit(0);

const settings = SettingsStore.loadSync(app.getPath('userData'), settingsEnvOverrides);
const startupGlobalShortcut = settings.startupValue('globalShortcut');

// Wayland apps cannot grab keys; Chromium can ask the xdg-desktop-portal instead. Opt-in only:
// KDE shows a confirmation dialog and persists the binding in ~/.config/kglobalshortcutsrc.
if (startupGlobalShortcut && process.platform === 'linux' && sessionEnv.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

let mainWin: BrowserWindow | null = null;
let runner: SelfTestRunner | null = null;
const audio = new AudioController();

function hardenSession(): void {
  const s = session.defaultSession;
  // Screen capture is allowed only during a screencast self-test.
  const screencastOk = (permission: string) => (permission === 'display-capture' || permission === 'media') && runner?.screencastActive === true;
  // The microphone is allowed ONLY while an audio session is active, and never for video.
  const MIC_PERMS = new Set(['media', 'microphone', 'audioCapture']);
  const micOk = (permission: string, wantsVideo: boolean) => MIC_PERMS.has(permission) && audio.micAllowed && !wantsVideo;
  s.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const wantsVideo = ((details as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? []).includes('video');
    cb(screencastOk(permission) || micOk(permission, wantsVideo));
  });
  s.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const wantsVideo = (details as { mediaType?: string } | undefined)?.mediaType === 'video';
    return screencastOk(permission) || micOk(permission, wantsVideo);
  });
  s.setDisplayMediaRequestHandler((_req, callback) => {
    if (!runner?.screencastActive) {
      callback({});
      return;
    }
    // On Wayland this opens the xdg-desktop-portal picker and returns the user's choice.
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });
}

function guard<A extends unknown[], R>(fn: (...args: A) => R) {
  return (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!isFromWindow(e, mainWin)) throw new Error('IPC from unexpected sender');
    return fn(...args);
  };
}

/** Windows facts for profile detection. NOT YET RUN ON WINDOWS (Windows is a later phase). */
function windowsProfiles() {
  const systemRoot = shellParentEnv().SystemRoot ?? 'C:\\Windows';
  let wslListOutput: Buffer | null = null;
  try {
    wslListOutput = execFileSync(`${systemRoot}\\System32\\wsl.exe`, ['--list', '--quiet'], { timeout: 3000 });
  } catch {
    // WSL absent or no distros.
  }
  const pf = shellParentEnv().ProgramFiles ?? 'C:\\Program Files';
  const pwsh = `${pf}\\PowerShell\\7\\pwsh.exe`;
  return detectWindowsShellProfiles({ systemRoot, comSpec: shellParentEnv().ComSpec, exists: existsSync, pwshPath: existsSync(pwsh) ? pwsh : null, wslListOutput });
}

function createPtyManager(tap: ReturnType<typeof createTerminalTap> | null): PtyManager {
  if (process.platform === 'win32') return makeManager(windowsProfiles(), tap);
  let etcShells = '';
  try {
    etcShells = readFileSync('/etc/shells', 'utf8');
  } catch {
    // Handled below: detection falls back to $SHELL, or throws if nothing is usable.
  }
  const profiles = detectShellProfiles({
    etcShells,
    userShell: sessionEnv.SHELL,
    isExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (p) => realpathSync(p),
  });
  return makeManager(profiles, tap);
}

function makeManager(profiles: ReturnType<typeof detectShellProfiles>, tap: ReturnType<typeof createTerminalTap> | null): PtyManager {
  return new PtyManager((file, args, opts) => nodePty.spawn(file, args, opts), profiles, () => buildChildEnv(shellParentEnv(), app.getVersion()), homedir(), {
    data: (sessionId, data) => {
      tap?.output.set(sessionId, [...(tap.output.get(sessionId) ?? []), data]);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.termData, sessionId, data);
    },
    exit: (sessionId, exitCode, signal) => {
      tap?.exits.set(sessionId, exitCode);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.termExit, sessionId, exitCode, signal ?? null);
    },
  });
}

app.whenReady().then(async () => {
  hardenSession();
  // Autotests type into a real shell and take screenshots: development builds only.
  const autotest = isProductionBuild() ? 'off' : config.autotest;

  const env = classifyEnvironment(process.platform, sessionEnv);
  const provider = env.kind === 'kwin-wayland' ? createKwinProvider() : createUnsupportedProvider(env.reason);

  const tap = ['terminal', 'ui-snapshot', 'visibility', 'library', 'tabs-settings', 'settings-readback', 'ai-explain'].includes(autotest) ? createTerminalTap() : null;
  const manager = createPtyManager(tap);
  if (tap) {
    const spawn = manager.spawn.bind(manager);
    manager.spawn = (profileId) => {
      const info = spawn(profileId);
      tap.spawned.push({ sessionId: info.sessionId, pid: info.pid, profileId: info.profileId });
      return info;
    };
  }
  registerTerminalIpc(() => mainWin, manager);

  // Every autotest uses a throwaway mongod (system binary, temp dir) — never the shared server.
  let memServer: { getUri(): string; stop(): Promise<boolean> } | null = null;
  if (autotest !== 'off') {
    const { MongoMemoryServer } = await import('mongodb-memory-server-core');
    memServer = await MongoMemoryServer.create({ binary: { systemBinary: '/usr/bin/mongod', version: '8.0.15' } });
    if (autotest === 'library') await pingRealMongo(settings.effective().library.mongoUri);
  }
  manager.setDefaultProfile(settings.effective().terminal.defaultProfile);
  const lib0 = settings.effective().library;
  const library = new LibraryService(memServer ? `${memServer.getUri()}inviterminal_autotest` : lib0.mongoUri, lib0.allowRemote, (s) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.libStatusChanged, s);
  });
  registerLibraryIpc(() => mainWin, library);
  void library.start();

  // AI: the key lives in the OS keychain (safeStorage), never in settings.json or the renderer.
  const keyStore = new KeyStore(app.getPath('userData'), safeStorage, process.env);
  const groq = new GroqClient(() => keyStore.getKey());
  registerAiIpc(() => mainWin, keyStore, groq, () => settings.effective().ai.model);
  // Autotests stub the model so the explain flow is verifiable without a key or network.
  const companion = new CompanionController(
    (st) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.companionStatusChanged, st);
      visibility.setSharing(st.running, st.clients, () => void companion.stop());
    },
    // Autotests use a random free port so they never collide with a real session's fixed port.
    () => (autotest !== 'off' ? 0 : settings.effective().companion.port),
  );
  ipcMain.handle(IPC.companionStatus, guard(() => companion.status()));
  ipcMain.handle(IPC.companionStart, guard(() => companion.start()));
  ipcMain.handle(IPC.companionStop, guard(() => companion.stop()));
  app.on('before-quit', () => void companion.stop());

  const explainStreamer: ExplainStreamer = autotest !== 'off' ? stubExplainStreamer : (opts, onDelta, signal) => groq.explainStream(opts, onDelta, signal);
  registerExplainIpc(() => mainWin, explainStreamer, () => settings.effective().ai.model, (text) => companion.push({ type: 'explanation', title: 'Terminal explanation', text, at: new Date().toISOString() }));
  const chatStreamer: ChatStreamer = autotest !== 'off' ? stubChatStreamer : (opts, onDelta, signal) => groq.chatStream(opts, onDelta, signal);
  registerPracticeIpc(() => mainWin, chatStreamer, () => settings.effective().ai.model);
  const answerStreamer: AnswerStreamer = autotest !== 'off' ? stubAnswerStreamer : (opts, onDelta, signal) => groq.answerStream(opts, onDelta, signal);
  registerLiveAnswerIpc(() => mainWin, answerStreamer, () => settings.effective().ai.model, (question, answer) => {
    const q = question.length > 200 ? `${question.slice(0, 200)}…` : question;
    companion.push({ type: 'explanation', title: 'AI answer', text: `Q: ${q}\n\n${answer}`, at: new Date().toISOString() });
  });

  // Settings: applied live where possible; startup-only values are flagged as needing a restart.
  settings.onChange((v) => {
    manager.setDefaultProfile(v.effective.terminal.defaultProfile);
    if (!memServer) void library.reconfigure(v.effective.library.mongoUri, v.effective.library.allowRemote);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(IPC.settingsChanged, v);
      void keyStore.status().then((key) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(IPC.aiStatusChanged, { model: v.effective.ai.model, key }));
    }
  });
  ipcMain.handle(IPC.settingsGet, (e) => {
    if (!isFromWindow(e, mainWin)) throw new Error('IPC from unexpected sender');
    return settings.view();
  });
  ipcMain.handle(IPC.settingsUpdate, (e, raw: unknown) => {
    if (!isFromWindow(e, mainWin)) throw new Error('IPC from unexpected sender');
    return settings.update(SettingsPatchSchema.parse(raw) as Parameters<SettingsStore['update']>[0]);
  });
  app.on('will-quit', () => {
    void library.close();
    void memServer?.stop();
  });

  const inputs = new Map<string, string[]>();
  if (autotest === 'library') {
    const input = manager.input.bind(manager);
    manager.input = (sessionId, data) => {
      inputs.set(sessionId, [...(inputs.get(sessionId) ?? []), data]);
      input(sessionId, data);
    };
  }

  const win = createWindow('main', { title: config.mainTitle, width: 980, height: 680 });
  mainWin = win;
  const controller = new ProtectionController(provider, win, (s) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.state, s);
  });
  runner = new SelfTestRunner(win, () => createWindow('control', { title: config.controlTitle, width: 640, height: 260 }));
  const r = runner;
  const visibility = registerVisibility(win);
  registerAudioIpc(() => mainWin, audio);
  const stt = new WhisperStt(() => ({
    binaryPath: settings.effective().stt.binaryPath,
    modelPath: settings.effective().stt.modelPath,
    defaultModelPath: join(app.getPath('userData'), 'models', 'ggml-base.en.bin'),
    tdrzModelPath: settings.effective().liveTranscript.tdrzModelPath,
    defaultTdrzModelPath: join(app.getPath('userData'), 'models', 'ggml-small.en-tdrz.bin'),
  }));
  registerSttIpc(() => mainWin, stt);
  // Autotests record the spoken text with a fake engine, so no real audio plays and the
  // renderer → main → engine chain is still observable.
  const ttsSpoken: string[] = [];
  const fakeTtsRun: RunTts = (_bin, args) => {
    ttsSpoken.push(args[args.length - 1] ?? '');
    return { done: Promise.resolve(), stop: () => undefined };
  };
  const tts = new TtsSpeaker(
    () => ({ binaryPath: settings.effective().tts.binaryPath, voice: settings.effective().tts.voice }),
    autotest !== 'off' ? fakeTtsRun : undefined,
  );
  registerTtsIpc(() => mainWin, tts);

  // Live meeting transcription (Phase 1): system-audio capture → whisper → streamed lines.
  // Autotests use a fake capture (scripted zero-filled chunks) + a scripted transcriber so the
  // renderer → IPC → panel chain is deterministic without real audio or the whisper model.
  const sendLive = (channel: string, ...args: unknown[]) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, ...args);
  };
  const liveScript = ['Tell me about yourself.', 'What is your biggest strength?', 'Describe a hard bug you fixed.'];
  let liveIdx = 0;
  const fakeTranscriber = {
    status: () => ({ available: true, binary: 'fake', binaryFound: true, model: 'fake', modelFound: true, reason: null }),
    diarizeStatus: () => ({ available: true, model: 'fake-tdrz', reason: null }),
    transcribe: async (_wav: string, o?: { diarize?: boolean }) => {
      const text = liveScript[liveIdx++ % liveScript.length]!;
      // When diarizing, pretend the chunk had two speaker turns.
      return o?.diarize ? { text, ms: 5, turns: [text, 'And how did you test it?'] } : { text, ms: 5 };
    },
  };
  const fakeLiveCapture: StartCapture = (): CaptureProcess => {
    let dataCb: ((b: Uint8Array) => void) | null = null;
    let emitted = 0;
    const chunkBytes = settings.effective().liveTranscript.chunkSeconds * 16_000 * 2;
    const timer = setInterval(() => {
      if (dataCb && emitted < liveScript.length) {
        dataCb(new Uint8Array(chunkBytes));
        emitted++;
      }
    }, 120);
    return { onData: (cb) => (dataCb = cb), onError: () => undefined, onClose: () => undefined, kill: () => clearInterval(timer) };
  };
  const live = new LiveTranscriptController(
    autotest !== 'off' ? fakeTranscriber : stt,
    autotest !== 'off' ? fakeLiveCapture : parecordCapture,
    () => settings.effective().liveTranscript.source ?? defaultMonitorSource(),
    () => settings.effective().liveTranscript.chunkSeconds,
    {
      line: (l) => sendLive(IPC.liveLine, l),
      state: (s) => {
        sendLive(IPC.liveStatusChanged, s);
        visibility.setLive(s.active, () => void live.stop());
      },
      error: (m) => sendLive(IPC.liveError, m),
    },
  );
  registerLiveIpc(() => mainWin, live);
  app.on('before-quit', () => void live.stop());

  audio.onChange((st) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(IPC.audioStatusChanged, st);
    visibility.setRecording(st, () => audio.stop());
  });
  // If the window is destroyed while recording, stop the mic (no orphaned capture).
  win.on('closed', () => { void audio.stop(); void companion.stop(); void live.stop(); });

  // register() returning true is not proof the key works (with the portal, the user has not even
  // confirmed yet); firedCount is what the autotest checks.
  const shortcut: ShortcutStatus = { accelerator: startupGlobalShortcut, registerReturned: null, firedCount: 0 };
  if (startupGlobalShortcut) {
    shortcut.registerReturned = globalShortcut.register(startupGlobalShortcut, () => {
      shortcut.firedCount++;
      void visibility.controller.toggle();
    });
    app.on('will-quit', () => globalShortcut.unregisterAll());
  }

  // A hidden-then-shown Wayland window is a new KWin window with the flag cleared, so every show re-applies.
  let first = true;
  win.on('show', () => {
    const done = first ? controller.initialise() : controller.protect();
    if (first && autotest === 'screenshot') void done.then(() => captureAutotest(win, controller, r));
    if (first && tap && autotest === 'terminal') void done.then(() => terminalAutotest(win, manager, tap));
    if (first && tap && autotest === 'tabs-settings') void done.then(() => tabsSettingsAutotest(win, tap, controller, settings.path));
    if (first && tap && autotest === 'settings-readback') void done.then(() => settingsReadbackAutotest(win, tap, () => settings.view()));
    if (first && autotest === 'ai-key') void done.then(() => aiKeyAutotest(win, settings.path, app.getPath('userData')));
    if (first && tap && autotest === 'ai-explain') void done.then(() => aiExplainAutotest(win, manager, tap, controller));
    if (first && autotest === 'mic-gate') void done.then(() => micGateAutotest(win, audio));
    if (first && autotest === 'stt') void done.then(() => sttAutotest(win));
    if (first && autotest === 'tts') void done.then(() => ttsAutotest(win, controller, ttsSpoken));
    if (first && autotest === 'practice') void done.then(() => practiceAutotest(win, controller));
    if (first && autotest === 'companion') void done.then(() => companionAutotest(win, companion));
    if (first && autotest === 'live') void done.then(() => liveTranscriptAutotest(win, controller, companion));
    if (first && tap && autotest === 'library') void done.then(() => libraryAutotest(win, manager, tap, controller, library, inputs, config.snapshotPath));
    if (first && autotest === 'portal-shortcut') void done.then(() => portalShortcutAutotest(win, shortcut));
    if (first && tap && autotest === 'visibility') {
      const childEnv = buildChildEnv(shellParentEnv(), app.getVersion());
      void done.then(() => visibilityAutotest(win, manager, tap, controller, visibility, r, childEnv));
    }
    if (first && tap && autotest === 'ui-snapshot' && config.snapshotPath) {
      const out = config.snapshotPath;
      void done.then(() => uiSnapshotAutotest(win, manager, tap, out, controller));
    }
    first = false;
  });

  const recheck = () => {
    if (!win.isDestroyed() && win.isVisible()) void controller.recheck();
  };
  const interval = setInterval(recheck, config.recheckIntervalMs);
  screen.on('display-added', recheck);
  screen.on('display-removed', recheck);
  powerMonitor.on('resume', recheck);
  powerMonitor.on('unlock-screen', recheck);
  win.on('closed', () => {
    clearInterval(interval);
    // No shell may outlive the window it was typed into.
    manager.killAll();
    mainWin = null;
  });
  app.on('before-quit', () => manager.killAll());

  ipcMain.handle(IPC.getState, guard(() => controller.get()));
  ipcMain.handle(IPC.protect, guard(() => controller.protect()));
  ipcMain.handle(IPC.unprotect, guard(() => controller.unprotect()));
  ipcMain.handle(IPC.recheck, guard(() => controller.recheck()));
  ipcMain.handle(
    IPC.selfTestScreenshot,
    guard(async () => {
      const rec = await r.screenshot();
      controller.recordSelfTest(rec);
      return rec;
    }),
  );
  ipcMain.handle(IPC.selfTestScreencastPrepare, guard(() => r.prepareScreencast()));
  ipcMain.handle(
    IPC.selfTestScreencastReport,
    guard((raw: unknown) => {
      const { error, ...rest } = ScreencastReportSchema.parse(raw);
      const rec = r.reportScreencast(error === undefined ? rest : { ...rest, error });
      controller.recordSelfTest(rec);
      return rec;
    }),
  );
});

/** Read-only reachability check of the configured (shared) MongoDB: a ping, no writes. */
async function pingRealMongo(uri: string): Promise<void> {
  const { default: mongoose } = await import('mongoose');
  const t0 = Date.now();
  try {
    const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2000, autoIndex: false, autoCreate: false }).asPromise();
    const ok = (await conn.db!.admin().ping()).ok === 1;
    await conn.close();
    console.log(`[autotest] ${JSON.stringify({ event: 'real-mongo-ping', ok, ms: Date.now() - t0 })}`);
  } catch (e) {
    console.log(`[autotest] ${JSON.stringify({ event: 'real-mongo-ping', ok: false, error: (e as Error).message })}`);
  }
}

/** Deterministic fake model for autotests: echoes a summary of what it was asked to explain. */
const stubExplainStreamer: ExplainStreamer = async (opts, onDelta, signal) => {
  // Observability for the ai-explain autotest: did the text the model would receive still
  // carry the planted canary? (It must not, after authoritative redaction.)
  console.log(`[autotest] ${JSON.stringify({ event: 'stub-received', hasCanary: opts.text.includes('gsk_autotest'), hasImage: !!opts.imageBase64, lines: opts.text.split(String.fromCharCode(10)).length })}`);
  const parts = [`[stub ${opts.model}] `, 'Explanation of ', `${opts.text.split(String.fromCharCode(10)).length} line(s)`, opts.imageBase64 ? ' with an image.' : '.'];
  let full = '';
  for (const p of parts) {
    if (signal.aborted) throw new Error('aborted');
    onDelta(p);
    full += p;
    await new Promise((r) => setTimeout(r, 30));
  }
  return full;
};

/** Deterministic fake interviewer for autotests: a question, or feedback + next question. */
const stubChatStreamer: ChatStreamer = async (opts, onDelta, signal) => {
  const last = opts.messages[opts.messages.length - 1];
  const isAnswer = last?.role === 'user' && last.content !== 'Please begin the interview.';
  const parts = isAnswer
    ? ['Feedback: good start. ', 'Next question: explain how you would scale it?']
    : ['[stub interviewer] ', 'Question 1: tell me about yourself.'];
  let full = '';
  for (const p of parts) {
    if (signal.aborted) throw new Error('aborted');
    onDelta(p);
    full += p;
    await new Promise((r) => setTimeout(r, 25));
  }
  return full;
};

/** Deterministic fake answer for autotests: echoes the line and the requested length. */
const stubAnswerStreamer: AnswerStreamer = async (opts, onDelta, signal) => {
  const parts = [`[stub ${opts.length}] `, 'Answer to: ', opts.text.slice(0, 40)];
  let full = '';
  for (const p of parts) {
    if (signal.aborted) throw new Error('aborted');
    onDelta(p);
    full += p;
    await new Promise((r) => setTimeout(r, 20));
  }
  return full;
};

app.on('window-all-closed', () => app.quit());
