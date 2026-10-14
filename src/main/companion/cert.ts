import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';

export interface Cert {
  key: string;
  cert: string;
  /** SHA-256 fingerprint (colon-hex), shown in the desktop UI and on the phone page for trust-on-first-use. */
  fingerprint256: string;
}

/**
 * A fresh self-signed certificate per sharing session, valid for the LAN IP and
 * localhost. EC/P-256 so generation is fast. The phone shows a one-time
 * "untrusted certificate" warning; the fingerprint lets the user confirm it.
 */
export async function generateCert(host: string): Promise<Cert> {
  const pems = await generate([{ name: 'commonName', value: host }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - 60_000),
    notAfterDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: host }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });
  return { key: pems.private, cert: pems.cert, fingerprint256: new X509Certificate(pems.cert).fingerprint256 };
}
