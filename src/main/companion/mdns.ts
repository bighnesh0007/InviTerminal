import type mDNS from 'multicast-dns';

type Responder = ReturnType<typeof mDNS>;

/** The name answered on the LAN while sharing, so the phone can use https://inviterminal.local:<port>. */
export const MDNS_NAME = 'inviterminal.local';

/**
 * A minimal in-process mDNS responder (multicast-dns, pure JS): while sharing is on it answers
 * A queries for `inviterminal.local` with the LAN IP — no system service (Avahi) required.
 * Best-effort by design: if UDP 5353 can't be bound, or a phone's resolver doesn't do mDNS
 * (support varies on Android), the IP address in the QR still works.
 */
export class MdnsResponder {
  private mdns: Responder | null = null;
  private ip = '';

  /** Starts answering for MDNS_NAME → ip. Returns false (and stays off) if it can't bind. */
  async start(ip: string): Promise<boolean> {
    this.stop();
    try {
      const { default: create } = await import('multicast-dns');
      const mdns = create({ interface: ip, reuseAddr: true, loopback: true });
      this.mdns = mdns;
      this.ip = ip;
      mdns.on('error', () => this.stop());
      mdns.on('query', (q) => {
        const asked = (q.questions ?? []).some((qq) => qq.name.toLowerCase() === MDNS_NAME && ['A', 'ANY'].includes(String(qq.type)));
        if (asked) this.announce();
      });
      this.announce(); // an unsolicited announcement primes caches on the LAN
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  private announce(): void {
    try {
      this.mdns?.respond({ answers: [{ name: MDNS_NAME, type: 'A', ttl: 120, flush: true, data: this.ip }] });
    } catch {
      // socket gone — ignore
    }
  }

  get running(): boolean {
    return this.mdns !== null;
  }

  stop(): void {
    const m = this.mdns;
    this.mdns = null;
    try {
      m?.destroy();
    } catch {
      // already closed
    }
  }
}
