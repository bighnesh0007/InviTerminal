import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Identity } from './Server';

const Stored = z
  .object({
    host: z.string().min(1).max(64),
    key: z.string().min(1),
    cert: z.string().min(1),
    fingerprint256: z.string().min(1),
    token: z.string().min(20),
  })
  .strict();
export type StoredPairing = z.infer<typeof Stored>;

const FILE = 'companion-pairing.json';

/**
 * Remembers the phone pairing (TLS key/cert + token) between sessions so a paired phone
 * reconnects without re-scanning. It is a secret — it lets a LAN device read what you push —
 * so it is written 0600 in the app data dir, atomically, and never in settings.json.
 * "Forget paired phones" deletes it, which rotates both the token and the certificate.
 */
export class PairingStore {
  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, FILE);
  }

  /** The stored pairing, or null if absent/corrupt (a corrupt file is treated as "not paired"). */
  async load(): Promise<StoredPairing | null> {
    try {
      return Stored.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return null;
    }
  }

  async save(p: { host: string } & Identity): Promise<void> {
    const tmp = join(this.dir, `.${FILE}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(Stored.parse(p)), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
