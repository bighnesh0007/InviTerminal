import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiModel } from '../../shared/ai';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SettingsView } from '../../shared/settings';
import { checkMongoUri } from '../library/mongo-uri';
import { SettingsSchema } from './schema';

/** INVI_* variables that override file values for this run only (dev, tests). */
export interface EnvOverrides {
  mongoUri?: string;
  allowRemote?: boolean;
  globalShortcut?: string;
  sttModelPath?: string;
  sttBinaryPath?: string;
  ttsBinaryPath?: string;
  ttsVoice?: string;
  companionPort?: number;
  aiModel?: AiModel;
}

const FILE = 'settings.json';
/** Values read once at startup; changing them is saved but only applied after a restart. */
const RESTART_PATHS = ['globalShortcut'] as const;

/**
 * Settings live in a JSON file in the app's data directory, not in MongoDB:
 * they include the MongoDB URI itself and must load when MongoDB is down.
 * Writes are atomic (temp file + rename) with mode 0600. An unreadable file
 * is moved aside, never overwritten, and the user is told.
 */
export class SettingsStore {
  private listeners: ((v: SettingsView) => void)[] = [];
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private stored: Settings,
    private readonly env: EnvOverrides,
    private readonly atStartup: Settings,
    private readonly loadWarning: string | null,
  ) {}

  static async load(dir: string, env: EnvOverrides = {}, now: () => Date = () => new Date()): Promise<SettingsStore> {
    return SettingsStore.loadSync(dir, env, now);
  }

  /** Synchronous because a startup-only setting (the portal shortcut flag) must be known before app 'ready'. */
  static loadSync(dir: string, env: EnvOverrides = {}, now: () => Date = () => new Date()): SettingsStore {
    const path = join(dir, FILE);
    let raw: string | null = null;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (raw === null) return new SettingsStore(dir, structuredClone(DEFAULT_SETTINGS), env, structuredClone(DEFAULT_SETTINGS), null);
    try {
      const parsed = SettingsSchema.parse(JSON.parse(raw));
      return new SettingsStore(dir, parsed, env, structuredClone(parsed), null);
    } catch (e) {
      const aside = `${path}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(path, aside);
      const why = e instanceof SyntaxError ? 'not valid JSON' : 'did not match the settings schema';
      return new SettingsStore(dir, structuredClone(DEFAULT_SETTINGS), env, structuredClone(DEFAULT_SETTINGS), `settings.json ${why}; it was moved to ${aside} and defaults are in use.`);
    }
  }

  get path(): string {
    return join(this.dir, FILE);
  }

  /** The settings the app runs with: file values, then environment overrides. */
  effective(): Settings {
    const s = structuredClone(this.stored);
    if (this.env.mongoUri !== undefined) s.library.mongoUri = this.env.mongoUri;
    if (this.env.allowRemote !== undefined) s.library.allowRemote = this.env.allowRemote;
    if (this.env.globalShortcut !== undefined) s.globalShortcut = this.env.globalShortcut;
    if (this.env.sttModelPath !== undefined) s.stt.modelPath = this.env.sttModelPath;
    if (this.env.sttBinaryPath !== undefined) s.stt.binaryPath = this.env.sttBinaryPath;
    if (this.env.ttsBinaryPath !== undefined) s.tts.binaryPath = this.env.ttsBinaryPath;
    if (this.env.ttsVoice !== undefined) s.tts.voice = this.env.ttsVoice;
    if (this.env.companionPort !== undefined) s.companion.port = this.env.companionPort;
    if (this.env.aiModel !== undefined) s.ai.model = this.env.aiModel;
    return s;
  }

  /** What startup-only settings were when the app started (effective values). */
  startupValue<K extends (typeof RESTART_PATHS)[number]>(key: K): Settings[K] {
    const s = structuredClone(this.atStartup);
    if (key === 'globalShortcut' && this.env.globalShortcut !== undefined) return this.env.globalShortcut as Settings[K];
    return s[key];
  }

  view(): SettingsView {
    const overriddenByEnv: string[] = [];
    if (this.env.mongoUri !== undefined) overriddenByEnv.push('library.mongoUri');
    if (this.env.allowRemote !== undefined) overriddenByEnv.push('library.allowRemote');
    if (this.env.globalShortcut !== undefined) overriddenByEnv.push('globalShortcut');
    if (this.env.sttModelPath !== undefined) overriddenByEnv.push('stt.modelPath');
    if (this.env.sttBinaryPath !== undefined) overriddenByEnv.push('stt.binaryPath');
    if (this.env.ttsBinaryPath !== undefined) overriddenByEnv.push('tts.binaryPath');
    if (this.env.ttsVoice !== undefined) overriddenByEnv.push('tts.voice');
    if (this.env.companionPort !== undefined) overriddenByEnv.push('companion.port');
    if (this.env.aiModel !== undefined) overriddenByEnv.push('ai.model');
    const restartRequired = RESTART_PATHS.filter((k) => JSON.stringify(this.effective()[k]) !== JSON.stringify(this.startupValue(k)));
    return { effective: this.effective(), overriddenByEnv, restartRequired: [...restartRequired], file: this.path, loadWarning: this.loadWarning };
  }

  onChange(cb: (v: SettingsView) => void): void {
    this.listeners.push(cb);
  }

  /**
   * Merges a patch, validates the whole result, then writes. Invalid input
   * throws with the reason and leaves both memory and the file unchanged.
   */
  update(patch: SettingsPatch): Promise<SettingsView> {
    const run = async () => {
      const merged = {
        ...this.stored,
        terminal: { ...this.stored.terminal, ...patch.terminal },
        shortcuts: { ...this.stored.shortcuts, ...patch.shortcuts },
        library: { ...this.stored.library, ...patch.library },
        globalShortcut: patch.globalShortcut !== undefined ? patch.globalShortcut : this.stored.globalShortcut,
        ai: { ...this.stored.ai, ...patch.ai },
        stt: { ...this.stored.stt, ...patch.stt },
        tts: { ...this.stored.tts, ...patch.tts },
        companion: { ...this.stored.companion, ...patch.companion },
      };
      const result = SettingsSchema.safeParse(merged);
      if (!result.success) throw new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const next = result.data;
      // Refuse a library URI the service would refuse anyway, so the user sees why at save time.
      const uri = checkMongoUri(next.library.mongoUri, next.library.allowRemote);
      if (!uri.ok) throw new Error(`library.mongoUri: ${uri.reason}`);
      await this.write(next);
      this.stored = next;
      const v = this.view();
      for (const l of this.listeners) l(v);
      return v;
    };
    const p = this.writeQueue.then(run, run);
    this.writeQueue = p.catch(() => undefined);
    return p;
  }

  private async write(s: Settings): Promise<void> {
    const tmp = join(this.dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600); // in case umask widened it
    await rename(tmp, this.path);
  }
}
