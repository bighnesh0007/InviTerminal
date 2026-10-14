import { toDataURL } from 'qrcode';
import type { CompanionStatus } from '../../shared/companion';
import { lanAddress } from './pairing';
import { CompanionServer, type PushMessage } from './Server';

/**
 * Owns the companion server's lifecycle and the status the UI shows. Sharing is
 * off by default; starting binds the server to the LAN IP and returns the QR.
 */
export class CompanionController {
  private readonly server: CompanionServer;
  private started: { url: string; host: string; port: number; fingerprint256: string } | null = null;
  private qrDataUrl = '';

  constructor(private readonly onChange: (s: CompanionStatus) => void) {
    this.server = new CompanionServer(() => this.emit());
  }

  status(): CompanionStatus {
    if (!this.started) return { running: false, clients: 0 };
    return { running: true, clients: this.server.clientCount, host: this.started.host, port: this.started.port, fingerprint: this.started.fingerprint256, qrDataUrl: this.qrDataUrl };
  }

  private emit(): void {
    this.onChange(this.status());
  }

  async start(): Promise<CompanionStatus> {
    if (this.started) return this.status();
    const host = lanAddress();
    if (!host) throw new Error('No LAN network found — connect to the same WiFi as your phone.');
    this.started = await this.server.start(host);
    // QR holds the full tokenised URL; generated in main so qrcode stays out of the renderer bundle.
    this.qrDataUrl = await toDataURL(this.started.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    this.emit();
    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.server.stop();
    this.started = null;
    this.qrDataUrl = '';
    this.emit();
  }

  get isRunning(): boolean {
    return this.started !== null;
  }

  /** Main-process only (never over IPC): the full tokenised URL, for the headless autotest. */
  currentUrl(): string | null {
    return this.started?.url ?? null;
  }

  /** Push content to paired phones; no-op when not sharing. Returns #phones reached. */
  push(msg: PushMessage): number {
    return this.started ? this.server.push(msg) : 0;
  }
}
