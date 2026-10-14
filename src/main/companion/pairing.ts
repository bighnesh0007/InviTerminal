import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

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

/** The machine's first non-internal IPv4 address (the LAN address to bind + put in the QR), or null. */
export function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}
