import { z } from 'zod';
import { isValidGlobalAccelerator } from './visibility/accelerator';

/** The only place environment variables are read. */
const EnvSchema = z.object({
  INVI_RECHECK_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(10_000),
  /** Development aid: drive the real app (capture self-test, or a real shell session), log JSON, and quit. */
  INVI_AUTOTEST: z.enum(['off', 'screenshot', 'terminal', 'ui-snapshot', 'visibility', 'portal-shortcut', 'library', 'tabs-settings', 'settings-readback', 'ai-key', 'ai-explain', 'mic-gate', 'stt', 'tts', 'practice', 'companion']).default('off'),
  /** Where ui-snapshot writes its PNG. Absolute path, .png only. */
  INVI_SNAPSHOT_PATH: z.string().regex(/^\/.+\.png$/).optional(),
  /** Overrides settings.json for this run (dev/tests): the portal global shortcut, e.g. "Control+Alt+T". */
  INVI_GLOBAL_SHORTCUT: z.string().refine(isValidGlobalAccelerator, 'not a valid global accelerator (needs a modifier)').optional(),
  /** Overrides settings.json for this run: the library MongoDB URI. */
  INVI_MONGODB_URI: z.string().optional(),
  /** Overrides settings.json for this run: "1" allows a non-local MongoDB. */
  INVI_MONGODB_ALLOW_REMOTE: z.enum(['0', '1']).optional(),
  /** Overrides settings.json for this run: whisper.cpp model and binary paths. */
  INVI_WHISPER_MODEL: z.string().optional(),
  INVI_WHISPER_BIN: z.string().optional(),
  /** Overrides settings.json for this run: text-to-speech binary and voice. */
  INVI_TTS_BIN: z.string().optional(),
  INVI_TTS_VOICE: z.string().optional(),
  /** Use another app data directory (settings, single-instance lock). Autotests use a temp dir so real settings are never touched. */
  INVI_USER_DATA_DIR: z.string().regex(/^\/.+/).optional(),
});

const env = EnvSchema.parse(process.env);

/** Session variables used only to pick a capture-exclusion provider. */
const SessionSchema = z.object({
  XDG_SESSION_TYPE: z.string().optional(),
  SHELL: z.string().optional(),
  XDG_CURRENT_DESKTOP: z.string().optional(),
  WAYLAND_DISPLAY: z.string().optional(),
  DISPLAY: z.string().optional(),
});

/**
 * The environment handed to shells (after buildChildEnv strips app-injected
 * variables). Read here so process.env stays confined to this module.
 */
export const shellParentEnv = (): Readonly<Record<string, string | undefined>> => ({ ...process.env });

export const sessionEnv: Readonly<Record<string, string | undefined>> = SessionSchema.parse(process.env);

export const config = {
  /** Neutral on purpose: the title shows up in screen-share pickers and task switchers. */
  mainTitle: 'InviTerminal',
  /** Must differ from mainTitle — the KWin provider identifies the main window by exact caption. */
  controlTitle: 'InviTerminal control canary (NOT protected)',
  recheckIntervalMs: env.INVI_RECHECK_INTERVAL_MS,
  autotest: env.INVI_AUTOTEST,
  snapshotPath: env.INVI_SNAPSHOT_PATH,
  userDataDir: env.INVI_USER_DATA_DIR,
  canaryPaintTimeoutMs: 3000,
  /** Extra time for a painted frame to reach the compositor. */
  compositorSettleMs: 250,
  screenshotTimeoutMs: 15_000,
  screencastTimeoutMs: 120_000,
} as const;

/** Environment values that override settings.json for this run only. */
export const settingsEnvOverrides = {
  ...(env.INVI_MONGODB_URI !== undefined ? { mongoUri: env.INVI_MONGODB_URI } : {}),
  ...(env.INVI_MONGODB_ALLOW_REMOTE !== undefined ? { allowRemote: env.INVI_MONGODB_ALLOW_REMOTE === '1' } : {}),
  ...(env.INVI_GLOBAL_SHORTCUT !== undefined ? { globalShortcut: env.INVI_GLOBAL_SHORTCUT } : {}),
  ...(env.INVI_WHISPER_MODEL !== undefined ? { sttModelPath: env.INVI_WHISPER_MODEL } : {}),
  ...(env.INVI_WHISPER_BIN !== undefined ? { sttBinaryPath: env.INVI_WHISPER_BIN } : {}),
  ...(env.INVI_TTS_BIN !== undefined ? { ttsBinaryPath: env.INVI_TTS_BIN } : {}),
  ...(env.INVI_TTS_VOICE !== undefined ? { ttsVoice: env.INVI_TTS_VOICE } : {}),
};
