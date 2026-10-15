---
type: results
status: Phases A–D done and verified (unit + headless autotest + real-hardware opt-in tests). pyannote not built (no sign-off). Auto-ask deliberately not built.
verified-on: 2026-10-15
---

# Phase 10 — Live transcript polish, better Ask, phone, speaker modes

Built on [Phase 9](10-phase9-live-transcript.md). Everything AI-related stays **manual**:
auto-ask (firing the AI on every new line and feeding the answers to the phone) was **not
built** — that is the covert auto-answer loop this project has kept out since Phase 7/8.

## A — Transcript UX
- **Pause / Resume** — pause kills the recorder (nothing is captured while paused); the session
  and its lines stay. A generation counter ignores late bytes from a killed recorder.
- **Search** (filters and highlights turns), **All / None** selection (applies to visible turns).
- **Merge same speaker** — consecutive lines from the same labelled speaker within 30 s join into one
  turn (never into a turn that already has an AI thread; never without speaker labels).
- **Rename speakers** ("Them" → "Interviewer"); remembered per viewer; used in copy/export/asks.
- **Edit a line** (✎) to fix a whisper mistake before asking — Enter saves, Esc reverts.
- **Copy** the transcript, **Export .md** (transcript + every AI thread) via a native Save dialog.

## B — Better Ask
- Every answer is a **thread**: **Copy · Save** (to the snippet library, folder "AI answers")
  **· ↻ Retry · Shorter · Longer**, and a **follow-up box** (earlier turns go along as history,
  capped at 20, all redacted in main).
- **✨ Summarize** — the whole conversation so far (most recent 15k chars) → summary, decisions,
  action items, open questions, at the chosen length.
- **Queued, not cancelled** — one request in flight (free-tier friendly); asks made meanwhile show
  "Queued…" and run in order. *Finding:* the first version cancelled the in-flight answer on a new
  Ask; the autotest showed only 3 of 5 answers reaching the phone. Queueing fixed it (5/5).
- Selection answers and summaries collect in a collapsible, height-capped **AI answers (N)** area.

## C — Phone
- **Remembered pairing** (default on): the TLS cert + token persist in
  `<data dir>/companion-pairing.json` (0600, atomic, never settings.json). A phone that scanned once
  **reconnects by itself**; the page remembers the token per host and retries with backoff.
  **Forget paired phones** rotates both. The cert is re-issued if the LAN IP changes (token kept).
  *Trade-off:* a persistent token on the LAN is weaker than a per-session one; mitigated by
  LAN-only binding, TLS, the visible indicator, and Forget.
- **Backlog replay** — the server keeps the last 30 answers + 200 transcript lines (in memory, per
  session) and replays them to a phone that (re)connects; a session id + sequence numbers stop
  duplicates.
- **Transcript to phone** (setting, default on) — the phone page has **Answers / Transcript** tabs,
  unread badges, **Copy** on every answer.
- **Named devices** — the phone names itself (the *only* message the server accepts from a phone:
  `{type:'name'}`, sanitised, 1 KB max payload); the Share panel lists who's connected.
- **Auto-start Share** (setting, default on) when you start Live or Ask; concurrent starts are safe.
- **`inviterminal.local`** — an in-process mDNS responder (`multicast-dns`, pure JS; no Avahi
  needed) answers while sharing; the cert includes the name and the server accepts that Origin.
  Phones need mDNS support and the firewall must allow UDP 5353 (the Share panel prints the ufw rule).

## D — Speaker modes
| Mode | How | Quality |
|---|---|---|
| Off | plain transcript | — |
| Turns | whisper tinydiarize (`-tdrz`) | weak on meeting audio (Phase 9 finding) |
| **You / Them** | **mic on the left channel + call audio on the right → whisper `-di`** | **reliable** |
| Stereo | the source's own L/R channels → `-di` | only if speakers are on separate sides |

*Finding:* whisper `-di` on a two-channel recording tags each JSON segment `speaker: "0"|"1"|"?"`
by channel energy, and was correct on a real interview clip split across channels. Mixing the mic
and the call into L/R turns that into **You / Them** without pyannote.

`StereoMixer` interleaves the two mono recorders. *Bug caught by the tests:* the first version
padded the quieter side as soon as the other was 0.25 s ahead — ordinary jitter between two
recorders would then shift one channel permanently. It now pads only a side that has been silent
≥ 300 ms (a suspended sink sends nothing) or a full second behind.

## Verification
- **267 tests** pass (+28), `npm audit --omit=dev` 0. New: StereoMixer (incl. jitter, both
  directions), pause/resume (late bytes ignored even after resume), all four modes, `-di` parsing
  (fixture shaped from a real run), merge/copy/markdown, summarize prompt, server session/seq,
  backlog replay, device names, alternate origin, identity reuse, PairingStore 0600/corrupt,
  controller remembered pairing + Forget + concurrent start.
- **Break-tested** (each guard removed → its test fails → restored): mixer jitter (both sides),
  pause late-bytes, phone-may-only-send-name, origin allow-list, backlog replay.
- **Headless `INVI_AUTOTEST=live`** (13 checks): consent gate; You/Them labels; rename; search;
  pause/resume; edit; Ask → follow-up → Longer; None/All; Ask selected; Summarize; copy; phone got
  10 transcript lines + all 5 answers; a late phone got the 5-answer backlog; gated; stop.
- **Real hardware (opt-in):** `INVI_REAL_LIVE=1` — real mic + real call audio + real whisper `-di`:
  every line of a playing interview labelled **"Them"**. `INVI_REAL_MDNS=1` — `inviterminal.local`
  resolved to the LAN IP on the real network stack.
- **Not verified:** a "You" line (needs someone speaking into the mic); a real phone resolving
  `.local` (Android support varies); the Export dialog (native dialog, not automatable here).

## Not built
- **Auto-ask** — by design (see top).
- **pyannote** — needs PyTorch + a HuggingFace model (~2 GB); no sign-off. You/Them covers the
  common case reliably.
