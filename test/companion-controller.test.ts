import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanionController } from '../src/main/companion/controller';
import { lanAddress } from '../src/main/companion/pairing';
import { PairingStore } from '../src/main/companion/pairing-store';

// Binds the real LAN address on a random port (like the app does); skipped on a machine with no LAN.
const HAS_LAN = lanAddress() !== null;

describe.skipIf(!HAS_LAN)('CompanionController — remembered pairing', () => {
  const tokenOf = (u: string | null) => u!.split('#t=')[1];

  it('reuses the same certificate + token across restarts; Forget rotates both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invi-ctl-'));
    const store = new PairingStore(dir);
    let remember = true;
    const ctl = new CompanionController(() => undefined, { getPort: () => 0, getRemember: () => remember, getMdns: () => false, store });
    try {
      const a = await ctl.start();
      const tokenA = tokenOf(ctl.currentUrl());
      expect(a.remembered).toBe(true);
      await ctl.stop();

      const b = await ctl.start();
      expect(b.fingerprint).toBe(a.fingerprint); // same cert → the phone's saved exception still applies
      expect(tokenOf(ctl.currentUrl())).toBe(tokenA); // same token → the phone reconnects without a scan

      const c = await ctl.forget(); // running → restarts with a fresh identity
      expect(c.running).toBe(true);
      expect(c.fingerprint).not.toBe(a.fingerprint);
      expect(tokenOf(ctl.currentUrl())).not.toBe(tokenA);
      await ctl.stop();

      // With remembering off, every session is fresh and nothing is persisted.
      remember = false;
      await store.clear();
      const d = await ctl.start();
      const tokenD = tokenOf(ctl.currentUrl());
      await ctl.stop();
      const e = await ctl.start();
      expect(e.fingerprint).not.toBe(d.fingerprint);
      expect(tokenOf(ctl.currentUrl())).not.toBe(tokenD);
      expect(await store.load()).toBeNull();
    } finally {
      await ctl.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('start() is safe to call concurrently (auto-start racing a click)', async () => {
    const ctl = new CompanionController(() => undefined, { getPort: () => 0, getRemember: () => false, getMdns: () => false, store: null });
    try {
      const [x, y] = await Promise.all([ctl.start(), ctl.start()]);
      expect(x.port).toBe(y.port);
      expect(x.fingerprint).toBe(y.fingerprint);
    } finally {
      await ctl.stop();
    }
  });
});
