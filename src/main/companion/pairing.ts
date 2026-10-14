import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** A URL-safe one-time pairing token. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time token comparison; false on any length mismatch. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Virtual interfaces carry non-internal IPv4s that a phone on your WiFi cannot reach
 * (docker0 172.17.x, VPN/VM/bridge nets). Picking one of those was why the QR showed an
 * unreachable address. Match by the usual name prefixes so the real LAN NIC wins.
 */
const VIRTUAL_IFACE = /^(docker|br-|virbr|veth|vmnet|vboxnet|tun|tap|wg|zt|tailscale|utun|llw|awdl)/i;

/**
 * The LAN address to bind + put in the QR: the first non-internal IPv4 on a **physical**
 * interface, falling back to any non-internal IPv4 if only virtual ones exist, else null.
 * `ifaces` is injectable for tests.
 */
export function lanAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | null {
  let fallback: string | null = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!VIRTUAL_IFACE.test(name)) return a.address; // a real LAN NIC — prefer it
      fallback ??= a.address; // remember a virtual one only if nothing better turns up
    }
  }
  return fallback;
}
