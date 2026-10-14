import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyStore, type SafeStorageLike } from '../src/main/ai/key-store';

// Reversible stand-in for the OS keychain. The "ciphertext" is tagged so a test can
// assert the plaintext key is never what lands on disk.
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from(`ENC::${Buffer.from(p, 'utf8').toString('base64')}`),
    decryptString: (e) => {
      const s = e.toString('utf8');
      if (!s.startsWith('ENC::')) throw new Error('not our ciphertext');
      return Buffer.from(s.slice(5), 'base64').toString('utf8');
    },
  };
}

const tempDir = () => mkdtemp(join(tmpdir(), 'invi-key-test-'));
const KEY = 'sk-ant-test-0123456789abcdef';

describe('KeyStore', () => {
  it('reports no key on a fresh store', async () => {
    const s = new KeyStore(await tempDir(), fakeSafeStorage(), {});
    expect(await s.getKey()).toBeNull();
    expect(await s.status()).toMatchObject({ source: 'none', present: false, hint: null });
  });

  it('encrypts a pasted key at rest (0600), reads it back, and never writes the plaintext', async () => {
    const dir = await tempDir();
    const s = new KeyStore(dir, fakeSafeStorage(), {});
    await s.setKey(`  ${KEY}  `); // trimmed
    expect(await s.getKey()).toBe(KEY);
    const file = join(dir, 'ai-key.enc');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw.startsWith('ENC::')).toBe(true);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // A fresh instance (cold cache) decrypts the same file.
    expect(await new KeyStore(dir, fakeSafeStorage(), {}).getKey()).toBe(KEY);
  });

  it('masks the key in status, never showing the whole thing', async () => {
    const s = new KeyStore(await tempDir(), fakeSafeStorage(), {});
    await s.setKey(KEY);
    const st = await s.status();
    expect(st).toMatchObject({ source: 'keychain', present: true });
    expect(st.hint).toBe('sk-ant…cdef');
    expect(st.hint).not.toContain(KEY);
  });

  it('lets the environment override and never persists it', async () => {
    const dir = await tempDir();
    const s = new KeyStore(dir, fakeSafeStorage(), { ANTHROPIC_API_KEY: `env-${KEY}` });
    expect(await s.getKey()).toBe(`env-${KEY}`);
    expect(await s.status()).toMatchObject({ source: 'env', present: true });
    expect(await readdir(dir)).toEqual([]); // nothing written
    await expect(s.setKey('another-key-value')).rejects.toThrow(/environment/);
  });

  it('accepts ANTHROPIC_AUTH_TOKEN as well', async () => {
    const s = new KeyStore(await tempDir(), fakeSafeStorage(), { ANTHROPIC_AUTH_TOKEN: 'tok-abcdefghij' });
    expect(await s.getKey()).toBe('tok-abcdefghij');
  });

  it('refuses to save when no keychain is available, and says to use the env var', async () => {
    const dir = await tempDir();
    const s = new KeyStore(dir, fakeSafeStorage(false), {});
    await expect(s.setKey(KEY)).rejects.toThrow(/environment variable/);
    expect(await s.status()).toMatchObject({ keychainUnavailable: true, present: false });
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a too-short key', async () => {
    const s = new KeyStore(await tempDir(), fakeSafeStorage(), {});
    await expect(s.setKey('short')).rejects.toThrow(/too short/);
    await expect(s.setKey('   ')).rejects.toThrow();
  });

  it('ignores a blank env var and falls through to the keychain', async () => {
    const dir = await tempDir();
    const s = new KeyStore(dir, fakeSafeStorage(), { ANTHROPIC_API_KEY: '   ' });
    await s.setKey(KEY);
    expect(await s.getKey()).toBe(KEY);
    expect(await s.status()).toMatchObject({ source: 'keychain' });
  });

  it('clears a stored key', async () => {
    const dir = await tempDir();
    const s = new KeyStore(dir, fakeSafeStorage(), {});
    await s.setKey(KEY);
    await s.clearKey();
    expect(await s.getKey()).toBeNull();
    expect(await readdir(dir)).toEqual([]);
    await s.clearKey(); // idempotent
  });

  it('treats an undecryptable file as absent (e.g. a new keychain identity)', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'ai-key.enc'), Buffer.from('garbage-not-ours'));
    const s = new KeyStore(dir, fakeSafeStorage(), {});
    expect(await s.getKey()).toBeNull();
    expect(await s.status()).toMatchObject({ source: 'none', present: false });
  });
});
