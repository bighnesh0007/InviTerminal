import { describe, expect, it } from 'vitest';
import { lanAddress } from '../src/main/companion/pairing';
import { MDNS_NAME, MdnsResponder } from '../src/main/companion/mdns';

// Real network stack. Opt-in (INVI_REAL_MDNS=1): binds UDP 5353 and multicasts on the LAN.
const REAL = process.env.INVI_REAL_MDNS === '1';

describe.skipIf(!REAL)('mDNS responder on the real network (INVI_REAL_MDNS=1)', () => {
  it(`answers an A query for ${MDNS_NAME} with the LAN IP`, async () => {
    const ip = lanAddress();
    expect(ip).toBeTruthy();
    const responder = new MdnsResponder();
    expect(await responder.start(ip!)).toBe(true);
    const { default: mdns } = await import('multicast-dns');
    const client = mdns({ loopback: true, reuseAddr: true });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no mDNS answer within 3s')), 3000);
        client.on('response', (r) => {
          const a = (r.answers ?? []).find((x) => x.name === MDNS_NAME && x.type === 'A') as { data?: unknown } | undefined;
          if (a) {
            clearTimeout(timer);
            resolve(String(a.data));
          }
        });
        client.query({ questions: [{ name: MDNS_NAME, type: 'A' }] });
      });
      expect(answer).toBe(ip);
    } finally {
      client.destroy();
      responder.stop();
    }
  }, 10_000);
});
