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
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  terminal: { fontSize: 13, scrollback: 5000, defaultProfile: null },
  shortcuts: { ...DEFAULT_KEYMAP },
  library: { mongoUri: DEFAULT_MONGODB_URI, allowRemote: false },
  globalShortcut: null,
};

export type SettingsPatch = {
  terminal?: Partial<Settings['terminal']>;
  shortcuts?: Partial<Keymap>;
  library?: Partial<Settings['library']>;
  globalShortcut?: string | null;
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
