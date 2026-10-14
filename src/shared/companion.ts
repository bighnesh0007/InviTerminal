export interface CompanionStatus {
  running: boolean;
  clients: number;
  host?: string;
  port?: number;
  /** SHA-256 cert fingerprint, shown so the user can confirm it on the phone. */
  fingerprint?: string;
  /** data:image/png QR of the tokenised pairing URL (never the raw token in the UI). */
  qrDataUrl?: string;
}
