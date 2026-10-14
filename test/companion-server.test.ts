import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'node:https';
import { WebSocket } from 'ws';
import { CompanionServer, type PushMessage } from '../src/main/companion/Server';
import { lanAddress, tokensEqual } from '../src/main/companion/pairing';

let server: CompanionServer | null = null;
const HOST = '127.0.0.1';

afterEach(async () => {
  await server?.stop();
  server = null;
});

function wssUrl(port: number): string {
  return `wss://${HOST}:${port}/`;
}

/** Resolves with the open socket, or rejects if the handshake is refused. */
function connect(url: string, protocols: string[], opts: Record<string, unknown> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
  });
}

function nextMessage(ws: WebSocket): Promise<PushMessage> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}

describe('pairing helpers', () => {
  it('compares tokens in constant time, length-safe', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', '')).toBe(true);
  });
  it('lanAddress returns an IPv4 string or null', () => {
    const a = lanAddress();
    expect(a === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(a)).toBe(true);
  });
});

describe('CompanionServer', () => {
  it('starts with a TLS cert (sha256 fingerprint) and a tokenised pairing URL', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    expect(s.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(s.url).toMatch(new RegExp(`^https://${HOST}:${s.port}/#t=[A-Za-z0-9_-]{40,}$`));
    expect(server.isRunning).toBe(true);
  });

  it('accepts a client with the token and greets it', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const token = s.url.split('#t=')[1]!;
    const ws = await connect(wssUrl(s.port), ['inviterminal', token], { rejectUnauthorized: false });
    expect((await nextMessage(ws)).type).toBe('hello');
    expect(server.clientCount).toBe(1);
    ws.close();
  });

  it('refuses a client with no token or the wrong token', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    await expect(connect(wssUrl(s.port), ['inviterminal'], { rejectUnauthorized: false })).rejects.toThrow();
    await expect(connect(wssUrl(s.port), ['inviterminal', 'not-the-token'], { rejectUnauthorized: false })).rejects.toThrow();
    expect(server.clientCount).toBe(0);
  });

  it('enforces TLS: a plaintext ws:// client and an untrusted-cert client are both refused', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const token = s.url.split('#t=')[1]!;
    await expect(connect(`ws://${HOST}:${s.port}/`, ['inviterminal', token])).rejects.toThrow();
    // rejectUnauthorized defaults to true → the self-signed cert is untrusted → refused.
    await expect(connect(wssUrl(s.port), ['inviterminal', token])).rejects.toThrow();
  });

  it('pushes a message to every paired client', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const token = s.url.split('#t=')[1]!;
    const ws = await connect(wssUrl(s.port), ['inviterminal', token], { rejectUnauthorized: false });
    await nextMessage(ws); // hello
    const got = nextMessage(ws);
    const n = server.push({ type: 'explanation', title: 'Explain', text: 'hello from desktop', at: new Date().toISOString() });
    expect(n).toBe(1);
    expect(await got).toMatchObject({ type: 'explanation', text: 'hello from desktop' });
    ws.close();
  });

  it('stops cleanly: the port is closed and new connections fail', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const port = s.port;
    await server.stop();
    expect(server.isRunning).toBe(false);
    await expect(connect(wssUrl(port), ['inviterminal', 'x'], { rejectUnauthorized: false })).rejects.toThrow();
    server = null;
  });

  it('serves the mobile page over HTTPS with a WS client and the cert fingerprint', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const body = await new Promise<string>((resolve, reject) => {
      get(`https://${HOST}:${s.port}/`, { rejectUnauthorized: false }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    expect(body).toContain('InviTerminal');
    expect(body).toContain('new WebSocket');
    expect(body).toContain(s.fingerprint256);
    expect(body).toContain("default-src 'none'"); // strict CSP on the phone page
  });

  it('refuses a second start while running', async () => {
    server = new CompanionServer();
    await server.start(HOST);
    await expect(server.start(HOST)).rejects.toThrow(/already running/);
  });
});
