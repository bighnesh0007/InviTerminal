import { randomBytes } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { createServer, type Server as HttpsServer } from 'node:https';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { generateCert } from './cert';
import { mobilePage } from './mobile-page';
import { newToken, tokensEqual } from './pairing';

/** Content the desktop pushes to the paired phone. The phone only displays it. */
export type PushMessage =
  | { type: 'hello'; session?: string }
  | { type: 'explanation'; title: string; text: string; at: string }
  | { type: 'answer'; title: string; question: string; text: string; at: string }
  | { type: 'transcript'; text: string; speaker?: string; at: string }
  | { type: 'meeting-summary'; title: string; text: string; at: string }
  /** The user cleared the conversation: phones wipe their view; the backlog is emptied too. */
  | { type: 'clear' };

/** The TLS key/cert and pairing token. Persisted by the controller so a phone stays paired. */
export interface Identity {
  key: string;
  cert: string;
  fingerprint256: string;
  token: string;
}

export interface Started {
  /** The full pairing URL for the QR: https://<host>:<port>/#t=<token> */
  url: string;
  host: string;
  port: number;
  fingerprint256: string;
}

const WS_PROTOCOL = 'inviterminal';
/** Recent pushes replayed to a phone that (re)connects, so nothing sent while it was away is lost. */
const BACKLOG_ANSWERS = 30;
const BACKLOG_TRANSCRIPT = 200;

/** A device name the phone reports; display-only, so strip control characters and cap it. */
export function cleanDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return name || null;
}

/**
 * LAN-only HTTPS + WebSocket server for the phone companion. Runs only while sharing is on,
 * bound to one host (the LAN IP), with TLS and a pairing token. It imports nothing from the
 * terminal/library/key code — it can only serve the static page and push what the caller hands
 * it. The only message it accepts from a phone is that phone's display name.
 */
export class CompanionServer {
  private https: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private token: string | null = null;
  private origins: string[] = [];
  private names = new Map<WebSocket, string>();
  private session = '';
  private seq = 0;
  private backlogAnswers: string[] = [];
  private backlogTranscript: string[] = [];

  /** @param onClients fired whenever the set of paired phones (or their names) changes. */
  constructor(private readonly onClients: (count: number) => void = () => {}) {}

  get isRunning(): boolean {
    return this.https !== null;
  }

  get clientCount(): number {
    let n = 0;
    for (const c of this.wss?.clients ?? []) if (c.readyState === 1) n++;
    return n;
  }

  /** Display names of the connected phones ("Phone" when one hasn't named itself). */
  devices(): string[] {
    const out: string[] = [];
    for (const c of this.wss?.clients ?? []) if (c.readyState === 1) out.push(this.names.get(c) ?? 'Phone');
    return out;
  }

  /**
   * @param port the TCP port to bind; 0 picks a random free one.
   * @param opts.identity reuse a remembered key/cert/token (else a fresh one is generated).
   * @param opts.altHost an extra hostname the page may be loaded from (e.g. "inviterminal.local").
   */
  async start(host: string, port = 0, opts: { identity?: Identity; altHost?: string } = {}): Promise<Started> {
    if (this.https) throw new Error('Companion server already running.');
    const identity = opts.identity ?? { ...(await generateCert(host, opts.altHost)), token: newToken() };
    this.token = identity.token;
    this.session = randomBytes(6).toString('hex');
    this.seq = 0;

    const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => this.serve(req, res, identity.fingerprint256));
    // Always-attached: a server 'error' (failed bind, or a later client-socket error) must never
    // reach Node's unhandled path and crash the app. The listen promise handles the first one.
    let onStartError: ((e: NodeJS.ErrnoException) => void) | null = null;
    server.on('error', (err: NodeJS.ErrnoException) => onStartError?.(err));
    this.wss = new WebSocketServer({ server, maxPayload: 1024, verifyClient: (info, cb) => this.verify(info.origin, info.req.headers['sec-websocket-protocol'], cb) });
    this.wss.on('error', () => undefined); // never let a ws-level error reach Node's unhandled path
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', session: this.session } satisfies PushMessage));
      for (const m of [...this.backlogAnswers, ...this.backlogTranscript]) ws.send(m);
      ws.on('message', (data) => this.onPhoneMessage(ws, data));
      ws.on('error', () => undefined);
      ws.on('close', () => {
        this.names.delete(ws);
        this.onClients(this.clientCount);
      });
      this.onClients(this.clientCount);
    });

    await new Promise<void>((resolve, reject) => {
      onStartError = (err) => {
        onStartError = null; // ignore any further errors; they're handled by the no-op above
        // Clean up the half-built server so a retry (e.g. with port 0) can succeed.
        this.wss?.close();
        this.wss = null;
        reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use. Pick another companion port in Settings, or set it to 0 for a random one.`) : err);
      };
      server.listen(port, host, () => {
        onStartError = null; // past the bind; leave the no-op handler attached for the server's life
        resolve();
      });
    });
    this.https = server;
    const boundPort = (server.address() as AddressInfo).port;
    this.origins = [`https://${host}:${boundPort}`, ...(opts.altHost ? [`https://${opts.altHost}:${boundPort}`] : [])];
    return { url: `${this.origins[0]}/#t=${identity.token}`, host, port: boundPort, fingerprint256: identity.fingerprint256 };
  }

  /** The only inbound message: the phone's display name. Anything else is ignored. */
  private onPhoneMessage(ws: WebSocket, data: unknown): void {
    try {
      const m = JSON.parse(String(data)) as { type?: unknown; name?: unknown };
      if (m.type !== 'name') return;
      const name = cleanDeviceName(m.name);
      if (name) this.names.set(ws, name);
      else this.names.delete(ws);
      this.onClients(this.clientCount);
    } catch {
      // not JSON — ignore
    }
  }

  /** WS auth: the token is offered as a subprotocol (not a URL param, so not in logs). */
  private verify(origin: string | undefined, protocolHeader: string | undefined, cb: (ok: boolean, code?: number, msg?: string) => void): void {
    const offered = (protocolHeader ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const supplied = offered.find((p) => p !== WS_PROTOCOL);
    if (!supplied || !this.token || !tokensEqual(supplied, this.token)) return cb(false, 401, 'unauthorized');
    // A browser page served by us sends one of our own Origins; reject any other. Non-browser clients send none.
    if (origin && !this.origins.includes(origin)) return cb(false, 403, 'forbidden');
    cb(true);
  }

  private serve(req: IncomingMessage, res: ServerResponse, fingerprint: string): void {
    if (req.url?.split('?')[0] === '/' || req.url === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(mobilePage({ origins: this.origins, fingerprint, protocol: WS_PROTOCOL }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  /** Push to every paired phone (and keep it for phones that connect later). Returns how many received it now. */
  push(msg: PushMessage): number {
    if (!this.https) return 0;
    const data = JSON.stringify({ ...msg, seq: ++this.seq });
    if (msg.type === 'clear') {
      // Cleared content must not come back to a phone that reconnects later.
      this.backlogAnswers = [];
      this.backlogTranscript = [];
    } else if (msg.type === 'transcript') {
      this.backlogTranscript.push(data);
      if (this.backlogTranscript.length > BACKLOG_TRANSCRIPT) this.backlogTranscript.shift();
    } else if (msg.type !== 'hello') {
      this.backlogAnswers.push(data);
      if (this.backlogAnswers.length > BACKLOG_ANSWERS) this.backlogAnswers.shift();
    }
    let n = 0;
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === 1) {
        c.send(data);
        n++;
      }
    }
    return n;
  }

  async stop(): Promise<void> {
    this.token = null;
    this.backlogAnswers = [];
    this.backlogTranscript = [];
    this.names.clear();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.https ? this.https.close(() => resolve()) : resolve()));
    this.wss = null;
    this.https = null;
    this.origins = [];
  }
}
