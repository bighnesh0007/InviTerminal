import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:https';
import { WebSocket } from 'ws';
import { cleanDeviceName, CompanionServer, type Identity, type PushMessage } from '../src/main/companion/Server';
import { generateCert } from '../src/main/companion/cert';
import { PairingStore } from '../src/main/companion/pairing-store';
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

  it('lanAddress prefers a physical NIC over docker/VPN interfaces a phone cannot reach', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
    // docker0 enumerated FIRST — the old code returned 172.17.0.1 (unreachable from the phone).
    expect(lanAddress({ docker0: [v4('172.17.0.1')], wlp1s0: [v4('192.168.1.6')] })).toBe('192.168.1.6');
    // loopback is skipped; a real NIC wins.
    expect(lanAddress({ lo: [v4('127.0.0.1', true)], eth0: [v4('10.0.0.5')] })).toBe('10.0.0.5');
    // only virtual present → fall back to it rather than null.
    expect(lanAddress({ docker0: [v4('172.17.0.1')] })).toBe('172.17.0.1');
    // nothing usable → null.
    expect(lanAddress({ lo: [v4('127.0.0.1', true)] })).toBeNull();
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

  it('binds the fixed port it is given (so one firewall rule keeps working)', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST, 0); // ask the OS for a free one, then reuse it as a "fixed" port
    const fixed = s.port;
    await server.stop();
    server = new CompanionServer();
    const s2 = await server.start(HOST, fixed);
    expect(s2.port).toBe(fixed);
  });

  it('reports a clear error and cleans up when the fixed port is already taken', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST, 0);
    const second = new CompanionServer();
    await expect(second.start(HOST, s.port)).rejects.toThrow(/already in use/);
    // The failed start left nothing running, so it isn't stuck "already running".
    expect(second.isRunning).toBe(false);
  });
});

describe('CompanionServer — remembered pairing, backlog, device names', () => {
  /** Connect and collect every message (hello + replay + live pushes). */
  async function collect(port: number, token: string, opts: Record<string, unknown> = {}) {
    const msgs: Record<string, unknown>[] = [];
    const ws = new WebSocket(wssUrl(port), ['inviterminal', token], { rejectUnauthorized: false, ...opts });
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_q, res) => reject(new Error(`http ${res.statusCode}`)));
    });
    return { ws, msgs };
  }
  const tokenOf = (url: string) => url.split('#t=')[1]!;

  it('hello carries a session id; every push carries an increasing seq', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    const { ws, msgs } = await collect(s.port, tokenOf(s.url));
    server.push({ type: 'answer', title: 'AI answer', question: 'q', text: 'a1', at: new Date().toISOString() });
    server.push({ type: 'transcript', text: 'hello there', speaker: 'Them', at: new Date().toISOString() });
    await vi.waitFor(() => expect(msgs.length).toBe(3));
    expect(msgs[0]).toMatchObject({ type: 'hello', session: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(msgs[1]).toMatchObject({ type: 'answer', seq: 1 });
    expect(msgs[2]).toMatchObject({ type: 'transcript', speaker: 'Them', seq: 2 });
    ws.close();
  });

  it('replays the backlog to a phone that connects later (so answers sent while away are not lost)', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    server.push({ type: 'answer', title: 'AI answer', question: 'q1', text: 'sent while no phone was connected', at: new Date().toISOString() });
    server.push({ type: 'transcript', text: 'line one', at: new Date().toISOString() });
    const { ws, msgs } = await collect(s.port, tokenOf(s.url));
    await vi.waitFor(() => expect(msgs.length).toBe(3));
    expect(msgs.map((m) => m.type)).toEqual(['hello', 'answer', 'transcript']);
    expect(msgs[1]).toMatchObject({ text: 'sent while no phone was connected', seq: 1 });
    ws.close();
  });

  it('clear is relayed to phones and empties the backlog, so cleared content never comes back', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST);
    server.push({ type: 'answer', title: 'AI answer', question: 'q', text: 'old answer', at: new Date().toISOString() });
    server.push({ type: 'transcript', text: 'old line', at: new Date().toISOString() });
    const first = await collect(s.port, tokenOf(s.url));
    await vi.waitFor(() => expect(first.msgs.length).toBe(3)); // hello + 2 replayed
    server.push({ type: 'clear' });
    await vi.waitFor(() => expect(first.msgs.at(-1)).toMatchObject({ type: 'clear' }));
    first.ws.close();
    const later = await collect(s.port, tokenOf(s.url));
    await new Promise((r) => setTimeout(r, 100));
    expect(later.msgs.map((m) => m.type)).toEqual(['hello']); // nothing old replayed
    later.ws.close();
  });

  it('records a phone-reported device name (sanitised); ignores any other message', async () => {
    const changes: number[] = [];
    server = new CompanionServer((n) => changes.push(n));
    const s = await server.start(HOST);
    const { ws } = await collect(s.port, tokenOf(s.url));
    await vi.waitFor(() => expect(server!.devices()).toEqual(['Phone']));
    ws.send(JSON.stringify({ type: 'name', name: 'Pixel\u0007 8' }));
    await vi.waitFor(() => expect(server!.devices()).toEqual(['Pixel 8']));
    ws.send(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' })); // not a thing — ignored
    ws.send('not json');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.devices()).toEqual(['Pixel 8']);
    ws.close();
    await vi.waitFor(() => expect(server!.devices()).toEqual([]));
  });

  it('accepts the page from its alternate (.local) origin, rejects any other origin', async () => {
    server = new CompanionServer();
    const s = await server.start(HOST, 0, { altHost: 'inviterminal.local' });
    const t = tokenOf(s.url);
    const ok = await collect(s.port, t, { origin: `https://inviterminal.local:${s.port}` });
    ok.ws.close();
    await expect(collect(s.port, t, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('reuses a remembered identity: same fingerprint and the same token still pairs', async () => {
    server = new CompanionServer();
    const first = await server.start(HOST);
    await server.stop();
    const identity: Identity = { key: '', cert: '', fingerprint256: '', token: tokenOf(first.url) };
    // Generate a real key/cert, then serve it twice to show the fingerprint is stable.
    const cert = await generateCert(HOST, 'inviterminal.local');
    Object.assign(identity, cert);
    server = new CompanionServer();
    const a = await server.start(HOST, 0, { identity });
    await server.stop();
    server = new CompanionServer();
    const b = await server.start(HOST, 0, { identity });
    expect(b.fingerprint256).toBe(a.fingerprint256);
    expect(tokenOf(b.url)).toBe(identity.token);
    const { ws } = await collect(b.port, identity.token);
    ws.close();
  });

  it('cleanDeviceName strips control characters, trims, caps length, rejects non-strings', () => {
    expect(cleanDeviceName('  My\u0000 Phone  ')).toBe('My Phone');
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(40);
    expect(cleanDeviceName(42)).toBeNull();
    expect(cleanDeviceName('   ')).toBeNull();
  });
});

describe('PairingStore', () => {
  it('saves with mode 0600, loads it back, treats a corrupt file as unpaired, and clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invi-pair-'));
    const store = new PairingStore(dir);
    expect(await store.load()).toBeNull();
    const p = { host: '192.168.1.6', key: 'K', cert: 'C', fingerprint256: 'AA:BB', token: 'T'.repeat(43) };
    await store.save(p);
    expect(await store.load()).toEqual(p);
    expect((await stat(join(dir, 'companion-pairing.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, 'companion-pairing.json'), '{not json');
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(await store.load()).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
