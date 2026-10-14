import { DEFAULT_AI_MODEL, type AiModel } from './ai';
import { DEFAULT_KEYMAP, type Keymap } from './keymap';

export const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/inviterminal';

export interface Settings {
  version: 1;
  terminal: {
    fontSize: number;
    scrollback: number;
    /** Profile id for new tabs; null = the detected default ($SHELL on Linux, cmd on Windows). */
    defaultProfile: string | null;
  };
  shortcuts: Keymap;
  library: {
    mongoUri: string;
    allowRemote: boolean;
  };
  /** Portal global toggle shortcut; null = none (use the CLI). Takes effect after a restart. */
  globalShortcut: string | null;
  ai: {
    /** Model for the explain/assist features. The API key is NOT here — it lives in the OS keychain. */
    model: AiModel;
  };
  stt: {
    /** Path to a whisper.cpp ggml model, or null for the default in the data dir. */
    modelPath: string | null;
    /** Path to the whisper-cli binary, or null to use it from PATH. */
    binaryPath: string | null;
  };
  tts: {
    /** Path to the text-to-speech binary, or null to use `espeak-ng` from PATH. */
    binaryPath: string | null;
    /** Voice/language for the engine (e.g. "en", "en-us"), or null for its default. */
    voice: string | null;
  };
  companion: {
    /** TCP port for "Share to phone". A fixed port lets you keep one firewall rule; 0 = random each time. */
    port: number;
  };
  liveTranscript: {
    /** PipeWire capture source (a monitor), or null to auto-detect the default output's monitor. */
    source: string | null;
    /** Seconds of audio per transcription chunk (lower = more live, higher = more accurate). */
    chunkSeconds: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  terminal: { fontSize: 13, scrollback: 5000, defaultProfile: null },
  shortcuts: { ...DEFAULT_KEYMAP },
  library: { mongoUri: DEFAULT_MONGODB_URI, allowRemote: false },
  globalShortcut: null,
  ai: { model: DEFAULT_AI_MODEL },
  stt: { modelPath: null, binaryPath: null },
  tts: { binaryPath: null, voice: null },
  // A fixed default so one firewall rule keeps working; the user can change it or set 0 for random.
  companion: { port: 41830 },
  liveTranscript: { source: null, chunkSeconds: 6 },
};

export type SettingsPatch = {
  terminal?: Partial<Settings['terminal']>;
  shortcuts?: Partial<Keymap>;
  library?: Partial<Settings['library']>;
  globalShortcut?: string | null;
  ai?: Partial<Settings['ai']>;
  stt?: Partial<Settings['stt']>;
  tts?: Partial<Settings['tts']>;
  companion?: Partial<Settings['companion']>;
  liveTranscript?: Partial<Settings['liveTranscript']>;
};

export interface SettingsView {
  /** What the app is using: the file, with environment overrides applied. */
  effective: Settings;
  /** Dotted paths whose value comes from an INVI_* environment variable (not editable in the UI). */
  overriddenByEnv: string[];
  /** Dotted paths changed since start that only apply after a restart. */
  restartRequired: string[];
  file: string;
  /** Set when the file was unreadable and has been moved aside. */
  loadWarning: string | null;
}
