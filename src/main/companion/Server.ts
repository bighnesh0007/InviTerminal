import { type AddressInfo } from 'node:net';
import { createServer, type Server as HttpsServer } from 'node:https';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { generateCert } from './cert';
import { newToken, tokensEqual } from './pairing';

/** Content the desktop pushes to the paired phone. One-way; the phone only displays. */
export type PushMessage =
  | { type: 'hello' }
  | { type: 'explanation'; title: string; text: string; at: string }
  | { type: 'meeting-summary'; title: string; text: string; at: string };

export interface Started {
  /** The full pairing URL for the QR: https://<host>:<port>/#t=<token> */
  url: string;
  host: string;
  port: number;
  fingerprint256: string;
}

const WS_PROTOCOL = 'inviterminal';
const MOBILE_PAGE = (origin: string, fp: string): string => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${origin.replace('https', 'wss')} ${origin}">
<title>InviTerminal companion</title>
<style>body{margin:0;font:15px system-ui,sans-serif;background:#111318;color:#e6e6e6;padding:14px}
h1{font-size:16px}.item{background:#1a1d24;border:1px solid #23262e;border-radius:8px;padding:10px;margin:8px 0;white-space:pre-wrap;word-break:break-word}
.who{font-size:11px;color:#9aa0aa;text-transform:uppercase}.fp{font-size:11px;color:#9aa0aa;word-break:break-all}.on{color:#7fd69d}.off{color:#ff8a80}
#hint{color:#9aa0aa;margin-top:18px;line-height:1.5}#hint b{color:#e6e6e6}</style>
</head><body>
<h1>InviTerminal <span id="s" class="off">connecting…</span></h1>
<p class="fp">cert: ${fp}</p>
<div id="hint">Waiting for the desktop…<br><br>On your computer, select some terminal output and run <b>Explain</b> (Ctrl+Shift+E). The explanation will appear here. This page only shows what you explicitly push — nothing else is shared.</div>
<div id="feed"></div>
<script>
  const t = location.hash.replace(/^#t=/, '');
  const ws = new WebSocket(location.origin.replace('https','wss') + '/', ['${WS_PROTOCOL}', t]);
  const s = document.getElementById('s'), feed = document.getElementById('feed'), hint = document.getElementById('hint');
  ws.onopen = () => { s.textContent='paired'; s.className='on'; hint.firstChild.textContent='Paired. '; };
  ws.onclose = () => { s.textContent='disconnected'; s.className='off'; };
  ws.onerror = () => { s.textContent='refused'; s.className='off'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type==='hello') return;
    hint.style.display='none';
    const d = document.createElement('div'); d.className='item';
    d.innerHTML = '<div class="who"></div><div class="tx"></div>';
    d.querySelector('.who').textContent = (m.title||m.type) + ' · ' + new Date(m.at).toLocaleTimeString();
    d.querySelector('.tx').textContent = m.text || '';
    feed.prepend(d); };
</script></body></html>`;

/**
 * LAN-only HTTPS + WebSocket server for the phone companion. Runs only while
 * sharing is on, bound to one host (the LAN IP), with TLS and a one-time token.
 * It imports nothing from the terminal/library/key code — it can only serve the
 * static page and push what the caller hands it.
 */
export class CompanionServer {
  private https: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private token: string | null = null;
  private origin = '';

  /** @param onClients fired with the live paired-client count on connect/disconnect. */
  constructor(private readonly onClients: (count: number) => void = () => {}) {}

  get isRunning(): boolean {
    return this.https !== null;
  }

  get clientCount(): number {
    let n = 0;
    for (const c of this.wss?.clients ?? []) if (c.readyState === 1) n++;
    return n;
  }

  /** @param port the TCP port to bind; 0 picks a random free one. A fixed port lets the user keep a single firewall rule. */
  async start(host: string, port = 0): Promise<Started> {
    if (this.https) throw new Error('Companion server already running.');
    const { key, cert, fingerprint256 } = await generateCert(host);
    this.token = newToken();

    const server = createServer({ key, cert }, (req, res) => this.serve(req, res, fingerprint256));
    // Always-attached: a server 'error' (failed bind, or a later client-socket error) must never
    // reach Node's unhandled path and crash the app. The listen promise handles the first one.
    let onStartError: ((e: NodeJS.ErrnoException) => void) | null = null;
    server.on('error', (err: NodeJS.ErrnoException) => onStartError?.(err));
    this.wss = new WebSocketServer({ server, verifyClient: (info, cb) => this.verify(info.origin, info.req.headers['sec-websocket-protocol'], cb) });
    this.wss.on('error', () => undefined); // never let a ws-level error reach Node's unhandled path
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello' } satisfies PushMessage));
      this.onClients(this.clientCount);
      ws.on('close', () => this.onClients(this.clientCount));
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
    this.origin = `https://${host}:${boundPort}`;
    return { url: `${this.origin}/#t=${this.token}`, host, port: boundPort, fingerprint256 };
  }

  /** WS auth: the token is offered as a subprotocol (not a URL param, so not in logs). */
  private verify(origin: string | undefined, protocolHeader: string | undefined, cb: (ok: boolean, code?: number, msg?: string) => void): void {
    const offered = (protocolHeader ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const supplied = offered.find((p) => p !== WS_PROTOCOL);
    if (!supplied || !this.token || !tokensEqual(supplied, this.token)) return cb(false, 401, 'unauthorized');
    // A browser page served by us sends our own Origin; reject any other. Non-browser clients send none.
    if (origin && origin !== this.origin) return cb(false, 403, 'forbidden');
    cb(true);
  }

  private serve(req: IncomingMessage, res: ServerResponse, fingerprint: string): void {
    if (req.url?.split('?')[0] === '/' || req.url === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(MOBILE_PAGE(this.origin, fingerprint));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  /** Push to every paired phone. Returns how many received it. */
  push(msg: PushMessage): number {
    const data = JSON.stringify(msg);
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
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.https ? this.https.close(() => resolve()) : resolve()));
    this.wss = null;
    this.https = null;
    this.origin = '';
  }
}
