import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyStatus } from '../../shared/ai';

/** The subset of Electron's safeStorage we use, so tests can inject a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

const FILE = 'ai-key.enc';
const MIN_KEY_LEN = 8;

function mask(key: string): string {
  if (key.length <= 8) return '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Stores the user's Groq API key. An environment variable
 * (GROQ_API_KEY), if set, always wins and is never
 * persisted. A pasted key is encrypted at rest with the OS keychain via
 * safeStorage and written 0600; it is never put in settings.json, never logged,
 * and never sent to the renderer — only getKey() (main process) returns it.
 */
export class KeyStore {
  private cached: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  private get path(): string {
    return join(this.dir, FILE);
  }

  private envKey(): string | undefined {
    const v = this.env.GROQ_API_KEY;
    return v && v.trim().length >= MIN_KEY_LEN ? v.trim() : undefined;
  }

  /** Loads the stored key into cache if the keychain can decrypt it. Idempotent. */
  private async loadStored(): Promise<string | null> {
    if (this.cached !== null) return this.cached;
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    try {
      const enc = await readFile(this.path);
      this.cached = this.safeStorage.decryptString(enc);
      return this.cached;
    } catch {
      return null; // absent or undecryptable
    }
  }

  /** For the main process only. Never expose over IPC. */
  async getKey(): Promise<string | null> {
    return this.envKey() ?? (await this.loadStored());
  }

  async status(): Promise<KeyStatus> {
    const env = this.envKey();
    if (env) return { source: 'env', present: true, keychainUnavailable: false, hint: mask(env) };
    const keychainUnavailable = !this.safeStorage.isEncryptionAvailable();
    const stored = keychainUnavailable ? null : await this.loadStored();
    return {
      source: stored ? 'keychain' : 'none',
      present: stored !== null,
      keychainUnavailable,
      hint: stored ? mask(stored) : null,
    };
  }

  /** Encrypt-and-save a pasted key. Rejects if the keychain is unavailable or the key is set via env. */
  async setKey(plain: string): Promise<void> {
    if (this.envKey()) throw new Error('A key is already set from the environment; unset GROQ_API_KEY to store one here.');
    const key = plain.trim();
    if (key.length < MIN_KEY_LEN) throw new Error('That key looks too short.');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('No OS keychain is available to encrypt the key, so it cannot be stored. Use the GROQ_API_KEY environment variable instead.');
    const enc = this.safeStorage.encryptString(key);
    const tmp = join(this.dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, enc, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    this.cached = key;
  }

  async clearKey(): Promise<void> {
    this.cached = null;
    await rm(this.path, { force: true });
  }
}
