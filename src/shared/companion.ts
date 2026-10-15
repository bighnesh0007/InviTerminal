export interface CompanionStatus {
  running: boolean;
  clients: number;
  /** Display names of the connected phones ("Phone" when unnamed). */
  devices: string[];
  host?: string;
  port?: number;
  /** SHA-256 cert fingerprint, shown so the user can confirm it on the phone. */
  fingerprint?: string;
  /** data:image/png QR of the tokenised pairing URL (never the raw token in the UI). */
  qrDataUrl?: string;
  /** The mDNS address (https://inviterminal.local:<port>) when the responder is up. */
  mdnsUrl?: string;
  /** True when the pairing is remembered, so already-paired phones reconnect without a scan. */
  remembered: boolean;
}
