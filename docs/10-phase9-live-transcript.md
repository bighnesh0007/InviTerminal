---
type: results
status: Live transcript + Ask-AI done and verified (fake capture/stub model headlessly; real capture→whisper verified by hand). Speaker labels built but tinydiarize detection is weak. Real Groq answers need the user's key.
verified-on: 2026-10-15
---

# Phase 9 — live meeting transcript + Ask-AI

A **disclosed, consent-gated** live transcript of the meeting audio playing on this
machine, with an on-demand "Ask AI" on the lines. Everything local except the explicit,
manual AI calls.

## 0. The line (unchanged)

The covert use — *auto-detect another person's question → auto-answer → feed it back live so
you can pass it off as your own* — is **not built**. What is built:

- **Live transcript**: captures the call audio, transcribes it **locally**, shows it, behind a
  **consent gate** (recording a call records everyone) + a visible **"● Live"** indicator.
- **Ask AI**: a **manual, per-line** (and per-selection) button. You choose which line(s) to
  send; the answer is shown openly. It is an aid you could disclose, not an automatic feed.

## 1. Pipeline (verified on the real machine)

```
PipeWire monitor (what's playing)  →  parecord raw s16le 16k mono  →  PcmChunker (fixed chunks)
   →  wrapPcm16Wav  →  whisper-cli (base.en)  →  line  →  Live panel  (+ "● Live" indicator)
```

- **Capture**: the default output sink's `.monitor` source (PipeWire), via
  `parecord -d <monitor> --rate=16000 --channels=1 --format=s16le --raw`. Captures whatever is
  playing (Meet/video/call) — no extra routing. **Measured**: transcribed a YouTube clip
  verbatim ("Notice how they use their body language…", "…flat delivery. There is no variation.").
  Requires the sink to be active; a suspended (silent) sink yields no bytes.
- **Chunking**: `PcmChunker` splits the continuous PCM into fixed chunks (settings
  `liveTranscript.chunkSeconds`, default 6, clamped 3–30). Each chunk → temp WAV → whisper.
  A **drop-oldest queue** (max 3) keeps it live if whisper falls behind. Independent chunks, so
  words can split at boundaries (acceptable for a live transcript).
- **Silence**: whisper emits "you"/"[BLANK_AUDIO]"/"thank you" for near-silence;
  `isSilenceTranscript` drops those (conservative, never filters real speech).
- **Indicator**: a dedicated tray entry (`setLive`) + header "● Live" badge, alongside the mic
  and sharing indicators. Behind the protection gate like every panel.

See [[live-transcript-local-pipeline]].

## 2. Speaker labels (Phase 1b) — built, but limited

`-tdrz` (tinydiarize, `ggml-small.en-tdrz.bin`, ~465MB, from
`akashmjn/tinydiarize-whisper.cpp` — **not** ggerganov's, which 404s). Toggle enabled only when
the model is present.

**Finding — the turn signal is JSON, and detection is weak.** This whisper-cli build does **not**
emit an inline `[SPEAKER_TURN]` marker on stdout (the first parser was wrong). The authoritative
signal is `speaker_turn_next` per segment in the `-oj` JSON. **Measured**: across two real
2-speaker interview captures with obvious handoffs, tinydiarize flagged **0 turns** — so in
practice lines often stay "Speaker 1". The mechanism is correct (when a turn *is* flagged, labels
alternate within the chunk); the model's detection is just weak on continuous meeting audio. True
per-speaker identity would need pyannote (PyTorch + HF model), deliberately out of scope.
See [[tinydiarize-detection-weak]].

## 3. Ask AI

- **Per line**: hover → **✨ Ask** → answer streams inline below the line.
- **Curated**: tick the turns you want → **"✨ Ask selected (N)"** → just those go to Groq as one
  conversation (in order, speaker-labelled when present); the combined answer streams into its own
  area.
- **Length**: Short / Medium / Detailed (remembered per viewer) → `answerParams()` sets the
  instruction and caps `max_tokens` (160 / 450 / 1024) so cost stays bounded.
- **Guards**: one answer in flight (a new ask cancels the previous); the line is
  **secret-masked in main** (`redactSecrets`) before it leaves the machine — same as Explain;
  disabled without a key. See [[ask-ai-on-transcript-manual-not-auto]].

## 4. Verification

- **Unit**: `PcmChunker`, `wrapPcm16Wav`, `isSilenceTranscript`, `parseTurnsFromJson`,
  `LiveTranscriptController` (consent/stt/source guards, chunk→line, silence drop, diarize
  alternation + unavailable-fallback), `answerParams`/`answerSystem`. Break-tested: consent guard,
  speaker alternation. **239 tests**, `npm run check` green.
- **Headless `INVI_AUTOTEST=live`** (fake capture + stub model): consent gate enforced; lines
  stream to the panel; Speaker 1/2 labels render; **✨ Ask** streams an answer; **✨ Ask selected
  (2)** streams a combined answer; gated behind protection; clean stop.
- **By hand on the real machine**: parecord monitor capture → whisper gave accurate transcripts;
  the tdrz model loads and runs (JSON path), detection measured as above.
- **Not verified**: real Groq answers in-app (needs the user's key — the standalone
  `scripts/test-groq.mjs` confirmed the key + model work end-to-end); an actual multi-speaker clip
  where tinydiarize fires.

## 5. Settings / files

- Settings → "Live transcript": capture source (null = default monitor), chunk seconds, tdrz model
  path (+ the download command).
- `src/main/audio/{PcmChunker,LiveTranscriptController,live-register}.ts`,
  `src/main/ai/live-answer.ts`, `src/renderer/live-transcript-panel.ts`, `src/shared/wav.ts`
  (`wrapPcm16Wav`), `src/shared/ai.ts` (answer lengths), `src/main/audio/WhisperStt.ts`
  (`diarizeStatus`, `parseTurnsFromJson`).
