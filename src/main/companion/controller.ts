import { toDataURL } from 'qrcode';
import type { CompanionStatus } from '../../shared/companion';
import { generateCert } from './cert';
import { MDNS_NAME, MdnsResponder } from './mdns';
import { lanAddress, newToken } from './pairing';
import type { PairingStore } from './pairing-store';
import { CompanionServer, type Identity, type PushMessage } from './Server';

export interface CompanionOptions {
  /** The configured TCP port (0 = random). A fixed port lets the user keep one firewall rule. */
  getPort: () => number;
  /** Remember the pairing across sessions (persisted by `store`); otherwise fresh every time. */
  getRemember: () => boolean;
  /** Answer `inviterminal.local` on the LAN while sharing. */
  getMdns: () => boolean;
  /** Where a remembered pairing lives; null disables remembering (tests, autotests). */
  store: PairingStore | null;
}

/**
 * Owns the companion server's lifecycle and the status the UI shows. Sharing is off by default;
 * starting binds the server to the LAN IP and returns the QR. With pairing remembered, the same
 * token + certificate are reused, so a phone that scanned once reconnects on its own.
 */
export class CompanionController {
  private readonly server: CompanionServer;
  private readonly mdns = new MdnsResponder();
  private started: { url: string; host: string; port: number; fingerprint256: string } | null = null;
  private qrDataUrl = '';
  private starting: Promise<CompanionStatus> | null = null;

  constructor(
    private readonly onChange: (s: CompanionStatus) => void,
    private readonly opts: CompanionOptions = { getPort: () => 0, getRemember: () => false, getMdns: () => false, store: null },
  ) {
    this.server = new CompanionServer(() => this.emit());
  }

  status(): CompanionStatus {
    const remembered = this.opts.getRemember() && this.opts.store !== null;
    if (!this.started) return { running: false, clients: 0, devices: [], remembered };
    return {
      running: true,
      clients: this.server.clientCount,
      devices: this.server.devices(),
      host: this.started.host,
      port: this.started.port,
      fingerprint: this.started.fingerprint256,
      qrDataUrl: this.qrDataUrl,
      ...(this.mdns.running ? { mdnsUrl: `https://${MDNS_NAME}:${this.started.port}` } : {}),
      remembered,
    };
  }

  private emit(): void {
    this.onChange(this.status());
  }

  /** The identity to serve: the remembered one if it still matches this LAN IP, else a new one. */
  private async identityFor(host: string): Promise<Identity> {
    const store = this.opts.getRemember() ? this.opts.store : null;
    const saved = store ? await store.load() : null;
    if (saved && saved.host === host) return saved;
    // New, or the LAN IP changed (the cert names the IP): re-issue the cert. Keep a remembered
    // token so a phone that saved it can still pair via inviterminal.local after an IP change.
    const cert = await generateCert(host, MDNS_NAME);
    const identity: Identity = { ...cert, token: saved?.token ?? newToken() };
    if (store) await store.save({ host, ...identity });
    return identity;
  }

  /** Idempotent and safe to call concurrently (auto-start may race a click). */
  start(): Promise<CompanionStatus> {
    if (this.started) return Promise.resolve(this.status());
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<CompanionStatus> {
    const host = lanAddress();
    if (!host) throw new Error('No LAN network found — connect to the same WiFi as your phone.');
    const identity = await this.identityFor(host);
    this.started = await this.server.start(host, this.opts.getPort(), { identity, altHost: MDNS_NAME });
    if (this.opts.getMdns()) await this.mdns.start(host);
    // QR holds the full tokenised URL; generated in main so qrcode stays out of the renderer bundle.
    this.qrDataUrl = await toDataURL(this.started.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    this.emit();
    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.mdns.stop();
    await this.server.stop();
    this.started = null;
    this.qrDataUrl = '';
    this.emit();
  }

  /** Forget paired phones: drop the remembered token + cert. If sharing, restart with fresh ones. */
  async forget(): Promise<CompanionStatus> {
    const wasRunning = this.started !== null;
    if (wasRunning) await this.stop();
    await this.opts.store?.clear();
    return wasRunning ? this.start() : this.status();
  }

  get isRunning(): boolean {
    return this.started !== null;
  }

  /** Main-process only (never over IPC): the full tokenised URL, for the headless autotest. */
  currentUrl(): string | null {
    return this.started?.url ?? null;
  }

  /** Push content to paired phones; no-op when not sharing. Returns #phones reached now. */
  push(msg: PushMessage): number {
    return this.started ? this.server.push(msg) : 0;
  }
}
