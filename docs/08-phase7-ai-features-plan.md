---
type: decision-record
status: decisions made (§7); step 7a (key store) built and verified; 7b next
verified-on: 2026-10-14
---

# Phase 7 — AI features: plan, feasibility, limitations

Two features, both scoped to **legitimate, transparent** use. This document is a
plan only; no code has been written. Evidence labels as in `01`:
**[LOCAL]** checked on this machine, **[DOC]** vendor docs (the bundled
`claude-api` reference), **[ASSUME]** not yet verified.

## 0. Scope and the line we are not crossing

InviTerminal hides its window from *accidental* capture during screen shares. The
AI features build on your **own** content and on **consented** audio. Two things
are explicitly out of scope, and the design makes them awkward rather than easy:

- **No covert interview/exam assistance.** Feature A explains *your* terminal
  output on demand; it is not wired to watch a call and surface answers. Feature B
  is a **practice** partner and a **consented** transcriber, not a live earpiece.
- **No secret recording of other people.** Any audio capture shows a persistent,
  unmissable recording indicator, names who must consent, and never starts hidden.

These are product decisions, not just docs: see the guardrails in §3.3 and §4.4.

---

## 1. Feature A — Explain terminal output with Claude

**What it does:** you select terminal output (or take the visible buffer), press a
key, and Claude explains it / suggests a fix in the side panel. For an error, a
stack trace, a failing test, a man-page excerpt.

### 1.1 What we send — text, not a screenshot (recommended)

The brief said "take a screenshot". For a *terminal* we can do strictly better,
because **we own the PTY stream and the xterm buffer** — we have the real text,
already decoded. Options:

| Source | Quality to the LLM | Cost | Notes |
|---|---|---|---|
| **xterm selection / visible buffer as text** (recommended) | Best: exact characters, no OCR errors | Cheapest: ~1 token per ~4 chars | We already have it; `Terminal.getSelection()` and the buffer API |
| `capturePage()` of our window → image block | Worse: the model OCRs pixels | ~1.1k–1.6k tokens per image [DOC] | Works even though the window is capture-excluded (our own process, proven in Phase 2). Useful only for *non-text* UI |
| Full-screen screenshot | Worst and a privacy problem | Highest | Rejected: pulls in everything else on screen |

**Recommendation:** send **text** (selection, or the last N lines). Offer an
"attach a picture of the pane" toggle that adds a `capturePage()` image block for
the rare case where layout/colour matters. Never the whole screen.

Claude vision takes image blocks as base64 PNG [DOC]; that path is ready if we
want it, but text is the default.

### 1.2 Model and request shape [DOC]

- SDK: `@anthropic-ai/sdk` (TypeScript), in the **main process** (the renderer
  never holds the key). ~13 MB unpacked [LOCAL] — a real bundle cost to weigh.
- Model: `claude-opus-5-5` default; a Settings dropdown to pick
  `claude-sonnet-5-5` (cheaper/faster) or `claude-haiku-4-5`.
- **Streaming** with adaptive thinking, so the answer appears token-by-token in
  the panel and long replies don't hit timeouts.
- A tight system prompt: "You explain terminal output for a developer. Be concise,
  show the fix as a command when there is one."

### 1.3 Where the key lives

- The user pastes their own Anthropic API key in Settings.
- Stored with Electron **`safeStorage`** (OS keychain / libsecret), **encrypted at
  rest**, never in `settings.json` plaintext. Availability is runtime-checked
  **[ASSUME]** — on a headless or no-keyring Linux box `safeStorage` can be
  unavailable, in which case we store nothing and say so.
- Alternatively, read `ANTHROPIC_API_KEY` / an `ant auth` profile from the
  environment if present [DOC], so a dev never pastes a key.
- The key is used only by the main process. The renderer asks "explain this" over
  IPC and gets streamed text back.

---

## 2. Feature B — Interview practice & consented transcription

The original idea (recognise everyone in a meeting, feed the *other* person's
speech to an LLM for answers) is the covert-assist case from §0. Reframed into two
features that use the same pipeline honestly:

### 2.1 B1 — Interview practice mode (recommended first)

- Claude plays an **interviewer**: it asks a question (shown, and optionally
  spoken via TTS), you answer **out loud**, we transcribe your answer and Claude
  gives **feedback** — on content, structure, and timing.
- Single speaker: it's just you, so **no diarization needed**. Push-to-talk or
  voice-activity start.
- This is the whole covert feature turned inside out: the model helps you *before*
  the real thing, on questions you drive, with nothing hidden.

### 2.2 B2 — Consented meeting notes (later, opt-in)

- Record a meeting **with everyone told**, transcribe, label speakers, and produce
  a summary + action items **afterwards** — not live answers.
- Speaker labelling (diarization) is the hard part; see §4.3. v1 can ship with
  **no diarization** (one transcript, timestamps) and add it later.

### 2.3 Audio capture — cross-platform via the renderer [DOC/ASSUME]

The renderer is Chromium, so **`navigator.mediaDevices.getUserMedia({audio})`**
captures the **microphone** on Windows and Linux with no platform-specific code.
That is the clean path, and it is the *mic* (your voice and the room), never system
audio.

- **Current blocker [LOCAL]:** `hardenSession()` denies every permission except
  display-capture during a screencast self-test (`index.ts:70`). Mic needs a new,
  **explicitly user-gated** allow — off by default, on only while a practice
  session or a consented recording is active, and reflected in the recording
  indicator.
- Capturing *other participants* in a real meeting means capturing **system/output
  audio** (the monitor source) or a meeting app's stream. On Linux that is a
  PipeWire monitor [LOCAL: `…​.monitor` source exists]; on Windows, WASAPI loopback.
  This is the part that records other people, so it is **B2-only, consented, and
  indicated** — never part of practice mode.

### 2.4 Speech-to-text — local, by default

Anthropic has **no speech-to-text API** [DOC: the Messages API is text/vision], so
STT is a separate engine. Neither Whisper nor any STT is installed [LOCAL].

| Engine | Privacy | Cross-platform | Cost |
|---|---|---|---|
| **whisper.cpp** (local, recommended) | Audio never leaves the machine | Yes, but needs a per-platform binary + a model file (~75 MB–1.5 GB) | Free, uses CPU/GPU |
| A cloud STT (e.g. a third-party API) | Audio leaves the machine to a **third party** | Yes | Per-minute cost, another key |

**Recommendation: local whisper.cpp.** It keeps voice on the machine, which is the
only defensible default for a tool that also records meetings. The cost is bundling
or downloading a binary and model per platform, and transcription latency on CPU.

### 2.5 Text-to-speech — optional

No TTS is installed [LOCAL]. For the interviewer's voice: **piper** (local neural
TTS, cross-platform) is the best quality; `espeak-ng` is tiny and robotic;
Chromium's `speechSynthesis` has **no voices on most Linux setups** [ASSUME].
**v1 can skip TTS** and just show the question as text — speaking it is a later
nicety.

---

## 3. Architecture (fits the existing shape)

```
main process (trusted, holds the key)
  ai/
    AnthropicClient.ts     @anthropic-ai/sdk; streaming; model from settings
    key-store.ts           safeStorage wrapper + env fallback; never logs the key
    explain.ts             builds the request from {text | image}, streams back
  audio/                   (Feature B)
    stt/whisper.ts         spawns whisper.cpp with explicit argv; temp wav, deleted
    practice.ts            interviewer loop: question → record → transcribe → feedback
  settings: + aiModel, + hasApiKey (never the key itself), + sttEngine, + audioConsented
renderer (sandboxed)
  ai-panel.ts              "Explain" result pane (streamed), practice UI, mic indicator
  (reuses the library/settings side-panel pattern and the protection gate)
```

- **IPC:** the renderer sends `{ text | wantImage }` and receives streamed chunks;
  it never sees the key. Every payload zod-validated and sender-checked, as in
  Phases 2–5.
- **Behind the protection gate:** the AI panel and the mic indicator are covered by
  the same gate/cover as the terminal, so an explanation containing secrets is not
  shown while unprotected.

### 3.3 Privacy guardrails for Feature A

- **Nothing is sent until you press the key** on a specific selection — never
  automatic, never the whole screen.
- A **confirm-preview** shows exactly what will be sent (first/last lines, byte
  count) before the first send of a session; a "don't ask again this session"
  option after that.
- An **optional redactor** masks obvious secrets (AWS keys, `Bearer` tokens,
  anything matching the Phase-4 secret shapes) before sending, shown struck-through
  in the preview.
- A visible note: "This sends the selected text to Anthropic." The destination is
  Anthropic only; no third party for text.

### 3.4 Consent guardrails for Feature B

- Microphone permission is **off by default** and asked for per session.
- A **persistent recording indicator** (tray + in-window) whenever the mic or
  system audio is live; it cannot be hidden by the panic-hide.
- Practice mode records **only your mic**. Capturing other participants (B2) is a
  **separate, explicit** action with an all-parties-consent reminder, and it is
  disabled until you confirm everyone has agreed.
- Transcripts and audio are **local**; audio is deleted after transcription unless
  you keep it.

---

## 4. Platform support & limitations

| Capability | Linux (KDE Wayland) | Windows 10/11 | Notes |
|---|---|---|---|
| A: terminal text → Claude | ✅ | ✅ | Pure text + SDK; no platform code |
| A: attach `capturePage()` image | ✅ | ✅ | Our own window; works while capture-excluded |
| Key in OS keychain (`safeStorage`) | ✅ libsecret [ASSUME headless] | ✅ DPAPI | Runtime-checked; env-var fallback |
| B: mic capture (getUserMedia) | ✅ [ASSUME portal] | ✅ | Needs the new mic permission gate |
| B: local STT (whisper.cpp) | ✅ | ✅ | Ship/download binary + model per OS |
| B: TTS interviewer voice | piper/espeak-ng | SAPI/piper | Optional; v1 text-only |
| B2: capture other participants | PipeWire monitor | WASAPI loopback | Consented + indicated only |
| B2: speaker diarization | hard | hard | §4.3 |

### 4.3 The hard limitation: speaker diarization

Telling *who* is speaking (you vs. others) needs a **diarization model**
(embeddings + clustering, e.g. pyannote-class models), which is heavier than
Whisper, often Python/torch, and imperfect on overlapping speech and unknown
numbers of speakers. **Honest position:** v1 of B2 ships **without** diarization —
a single timestamped transcript. Diarization is a later investigation with its own
model, its own accuracy caveats, and likely a Python sidecar. I will not claim it
works until it is measured.

### 4.4 What none of this does

- It is **not** a live answer feed for interviews or exams (§0).
- STT and diarization are **best-effort**: accents, jargon, noise and crosstalk all
  degrade them; the transcript is an aid, not a record of truth.
- Sending terminal text to Anthropic means it **leaves your machine**; the
  redactor reduces but cannot guarantee removal of secrets.

---

## 5. Dependencies this adds

| Dep | For | Cost |
|---|---|---|
| `@anthropic-ai/sdk` | Feature A/B LLM calls | ~13 MB unpacked [LOCAL]; bundled, so main-bundle grows |
| whisper.cpp binary + model | Local STT | per-OS binary; model 75 MB–1.5 GB downloaded on first use |
| piper (optional) | TTS | per-OS binary + voice model |
| (diarization, later) | B2 speaker labels | likely a Python sidecar |

`@anthropic-ai/sdk` becomes a runtime dependency; it should be **lazy-loaded** like
Mongoose (Phase 5) so the `--toggle` hotkey process doesn't parse it.

---

## 6. Roadmap (incremental, each step verified)

| Step | Deliverable | Exit check |
|---|---|---|
| **7a** | Key store (`safeStorage` + env fallback), Settings field (stores `hasApiKey`, never the key), a "test key" button | A real `count_tokens`/tiny call succeeds; the key never appears in `settings.json`, logs, or IPC to the renderer (asserted) |
| **7b** | Feature A: explain selected terminal text, streamed to the panel, behind the gate, with the confirm-preview and redactor | Live: explain a real error; the preview shows what's sent; a planted fake secret is masked; the panel is covered when unprotected |
| **7c** | Mic permission gate + recording indicator (no STT yet) | Mic is denied until a session starts; the indicator shows and survives panic-hide; off by default |
| **7d** | Local STT (whisper.cpp) wired to a push-to-talk capture | A spoken sentence transcribes locally; the wav is deleted; nothing leaves the machine |
| **7e** | Interview practice mode (B1): interviewer Q → your spoken answer → feedback | A full practice round, text interviewer; measured latency |
| **7f** (optional) | TTS interviewer voice; B2 consented notes (no diarization) | Consent reminder + indicator verified; transcript + summary produced |
| **later** | Diarization investigation for B2 | Measured accuracy before any claim |

**MVP = 7a–7b** (the screenshot/explain feature you asked for first). B is 7c–7e.

---

## 7a — Done (2026-10-14): the API key store

Decisions (§7): text+image input, **A first**, local whisper.cpp, keychain + env, default `claude-opus-5-5`.

Built and verified:
- `KeyStore` (`src/main/ai/key-store.ts`): env (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`)
  wins and is never persisted; a pasted key is encrypted with Electron `safeStorage`,
  written `0600`, never in `settings.json`, never sent back to the renderer.
- `AnthropicClient` (`src/main/ai/AnthropicClient.ts`): lazy-loads the SDK (external to
  the bundle, like Mongoose), `testKey()` via free `count_tokens`, streamed `explainStream()`
  ready for 7b.
- Settings panel: model dropdown + key field (Save/Clear/Test), env/keychain-unavailable
  states, masked hint.

Verified: 10 key-store unit tests (+ mutation checks: world-readable file, overwrite-on-env,
save-without-keychain, plaintext-store, ignore-env, short-key — all caught); the model
setting round-trips and rejects unknown models; 158 tests total; `npm audit --omit=dev` 0.
**Live on this machine** (`INVI_AUTOTEST=ai-key`, no network): `safeStorage` available, a
pasted key stored encrypted at `0600`, absent from `settings.json`, masked in the hint,
removed on clear. **Not verified:** a real `testKey()` network call — no API key in this
environment.

## 7. Decisions (made 2026-10-14)

1. **Feature A input:** terminal **text** (recommended) with an optional attached
   image, or image-only ("screenshot") as the brief literally said?
2. **Order:** build **A first** (7a–7b), then B? Or B first?
3. **STT engine:** local **whisper.cpp** (recommended, private) or a cloud STT?
4. **API key:** OS keychain via `safeStorage` (recommended), or also accept
   `ANTHROPIC_API_KEY` from the environment for dev?
5. **Default model:** `claude-opus-5-5` (recommended) or start on the cheaper
   `claude-sonnet-5-5`?
