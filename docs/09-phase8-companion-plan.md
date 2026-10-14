---
type: decision-record
status: 8a–8c built and verified headlessly (server + Share panel + explanation push). Real phone scan is the user's check. 8d (meeting summaries) deferred.
verified-on: 2026-10-14
---

# Phase 8 — web companion (phone second-screen), plan

A QR-paired web UI you open in a phone browser on the same WiFi. The desktop app
**pushes its own content** to the phone: a terminal explanation, or a finished
(consent-based) meeting summary. The phone is a **second screen for InviTerminal's own
output**, not a live feed.

## 0. Scope and the line (unchanged from Phase 7)

**Chosen uses (per the user, 2026-10-14):**
1. **Push explanations to phone** — run Explain on the desktop; the streamed answer also
   appears on the paired phone, to read / copy / save.
2. **Consent-based meeting notes** — with everyone informed, record → transcribe locally
   (whisper) → summarise (Groq) → push the **summary + action items** to the phone *after*
   the meeting.

**Explicitly out of scope:** a live feed of AI answers to the phone *during* a meeting or
interview from other people's speech. That is covert assistance to people who have not
consented, and this design makes it deliberately hard: the phone only ever receives
content you **explicitly push** (a finished explanation, or a finished summary), never a
live transcription/answer stream. Meeting notes are post-hoc and consent-gated, reusing
the Phase 7c consent + recording indicator.

## 1. The privacy tension, named

InviTerminal's whole job is keeping content *off* screens. This feature deliberately sends
some content *to* your phone over the LAN. That is acceptable only because it is:
- **opt-in and off by default** (no server runs until you start sharing);
- **LAN-only** (bound to your WiFi IP, never the public internet, no cloud relay);
- **encrypted** (TLS) and **authenticated** (a one-time pairing token);
- **scoped** (only what you push, not the terminal or snippets);
- **indicated** (a persistent "📱 Sharing" badge + tray item, like the REC badge), and
  stoppable in one click.

## 2. Architecture

```
Desktop (Electron main, trusted)                 Phone browser (same WiFi)
  companion/
    Server.ts        HTTPS + WSS on <lan-ip>:<port>   ──TLS──▶  static page + WS client
    pairing.ts       one-time token; QR payload                 (reads #token, connects WSS)
    cert.ts          self-signed cert (selfsigned), per session
    push.ts          typed messages: { explanation | meeting-summary }
  renderer: a "Share to phone" panel — shows the QR, the sharing badge, Stop.
```

- **Server**: Node's built-in `https` + `ws` (WebSocket). Bound to the **LAN IP only**
  (`172.16.5.45` here), not `0.0.0.0`, on an ephemeral port. Serves one small static page
  (the mobile UI, built like the renderer) and a WSS endpoint.
- **QR**: encodes `https://<lan-ip>:<port>/#t=<token>`. The token is in the URL **fragment**,
  so it is never sent in an HTTP request line (stays client-side, out of any logs) until the
  page uses it in the WSS handshake. QR generated with `qrcode`.
- **Push**: when you run Explain (or finish a meeting summary), main sends a typed message
  over every authenticated WS. One-way (desktop → phone); the phone only displays.
- **Mobile UI**: a static HTML/JS page (same no-framework style as the renderer), served by
  the companion server. Shows pushed explanations and summaries; copy button; dark theme.

## 3. Security design (the part that matters)

| Threat | Mitigation |
|---|---|
| Content sniffed on WiFi | **TLS** (self-signed cert, generated per sharing session). Phone shows a one-time "untrusted certificate" warning; you tap through. The cert's fingerprint is shown in the desktop UI and on the QR page so you can confirm it matches (trust-on-first-use) |
| Anyone on the LAN connects | **One-time pairing token** (32 random bytes, base64url) required on the WSS handshake; constant-time compare. Unknown/absent token → connection refused |
| Token leaks via logs/URL | Token lives in the URL **fragment**, never the request path; never logged; server holds only its hash |
| Port left open | Server runs **only while sharing is on**; Stop (button/tray/window-close) tears it down and invalidates the token |
| Exposure scope | The server pushes **only** explanations and finished summaries — it has **no** access to the terminal, PTY, snippets, or the AI key. Separate module, no imports of those |
| Public-internet exposure | Bound to the LAN IP; refuses to start if the only address is public/loopback-mismatched. Documented: do not port-forward |
| CSRF / other origins | WSS checks `Origin`; the static page sets a strict CSP; no cookies (token-in-fragment, not cookie) |
| Replay after stop | Token is single-session and random; a new session = new token + new cert |

Residual, disclosed: a determined attacker **already on your WiFi** who also gets the
token (e.g. shoulder-surfs the QR) could connect; TLS stops passive sniffing but not a
shared token. The badge makes an active session visible. For a hostile network, don't use
it.

## 4. Technology & dependencies

| Dep | For | Cost |
|---|---|---|
| `ws` 8.x | WebSocket server | small, widely used |
| `qrcode` 1.5.x | QR generation | small |
| `selfsigned` 5.x | per-session TLS cert | pulls `node-forge`; audited before adding |

Node's built-in `https`/`http` serves the static page. All three are **main-process only**
and should be **external to the bundle** (like mongoose/groq) so the `--toggle` process
never parses them. The mobile page is a separate tiny build artifact.

## 5. Platform

| | Linux (KDE) | Windows |
|---|---|---|
| LAN server + QR + push | ✅ | ✅ (same Node APIs) |
| Firewall | KDE/ufw may prompt to allow the port | Windows Defender Firewall will prompt on first run — documented |
| TLS trust on phone | one-time warning tap | same |

Cross-platform by construction (pure Node networking). The firewall prompt on first run is
expected and documented.

## 6. Roadmap (incremental, each step verified)

| Step | Deliverable | Exit check |
|---|---|---|
| **8a** | `companion/Server.ts` + pairing + self-signed cert; **no UI** — a dev autotest that starts it, connects a WSS client with the token (and one without), asserts auth works and TLS is on | Token-less connection refused; token connection receives a test push; cert fingerprint stable; server stops cleanly, port closed |
| **8b** | "Share to phone" panel: QR, fingerprint, sharing badge (header + tray), Stop | Scanning pairs; badge shows; Stop tears down. Verified on your phone |
| **8c** | Push **explanations**: Explain result also goes to the phone when sharing is on | A real explanation appears on the phone |
| **8d** | **Meeting summary** push: record (consent) → local transcribe → Groq summary → phone | A consented recording produces a summary on the phone |

**MVP = 8a–8c.** 8d builds on the deferred notes work.

## Done (2026-10-14): 8a–8c

Decisions (§7): add `ws`+`qrcode`+`selfsigned` (external to the bundle); separate mobile
page; server-security-first; document the Windows firewall prompt.

- **8a** `companion/{cert,pairing,Server}.ts`: LAN HTTPS + WSS, per-session self-signed EC
  cert (SHA-256 fingerprint), one-time token offered as a WS **subprotocol** (not a URL
  param), Origin-checked, serves one strict-CSP mobile page. Imports nothing from
  terminal/library/key code.
- **8b** `companion/controller.ts` + Share panel: Start/Stop, QR (generated in main, so
  `qrcode` stays out of the renderer bundle), cert fingerprint, live paired-device count, a
  header **"📱 Sharing"** badge + tray item. Behind the gate, so the token-bearing QR is
  never on a shared screen.
- **8c** explanations are pushed to paired phones (the explain `onResult` → `companion.push`).

Verified: 10 server tests (token auth, **TLS enforced** — plaintext ws:// and untrusted-cert
both refused, push, clean stop, HTTPS page with strict CSP), no-token mutation caught; 197
tests total; `npm audit --omit=dev` 0; capture regression passes. **Live
(`INVI_AUTOTEST=companion`, real LAN IP 172.16.5.45):** Start → running with a PNG QR and a
valid fingerprint; a real `ws` client paired with the token over TLS (app saw 1 device); an
explanation (stub) was **pushed and received** by the client; Stop closed it. Screenshot in
`docs/`. **Not verified:** an actual phone scanning the QR (yours to do); **8d** (consent-based
meeting summaries → phone) is deferred with the notes work.

## 7. Decisions needed from you

1. **Dependencies:** OK to add `ws` + `qrcode` + `selfsigned` (I'll audit them first and keep
   them external to the bundle)? Or prefer I hand-roll the WS/QR to avoid deps (more code,
   smaller surface)?
2. **Mobile UI build:** a separate tiny static page (my recommendation), or reuse part of the
   renderer?
3. **Start 8a** (the server + pairing + security, headless and autotested) before any UI, so
   we prove the security model first? (Recommended.)
4. **Windows firewall:** fine to document the one-time Defender prompt, or do you want the
   app to try to add a rule (needs elevation — I'd avoid that)?
