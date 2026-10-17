---
type: results
status: Implemented and verified (unit + real app with a stubbed model). Real Groq calls and the real-world false-positive rate are not measured.
verified-on: 2026-10-17
---

# Usage tracker + Auto-explain errors

Branch `phase10/polish`: `e2f31d3` (usage tracker), `c5ad884` (quit-flush fix), `734d350`
(Auto-explain).

## 1. Usage tracker (local only)

**Purpose:** see which features get used, so unused ones can be retired next phase.

**Stored:** `~/.config/inviterminal/usage.json`, `{ actionId: { count, lastUsed } }`. Only
static action IDs, counts and ISO times. Never commands, transcripts, prompts, AI answers,
screenshots, audio, secrets. Never sent to the phone, MongoDB or any AI provider.

| Piece | Where |
|---|---|
| The 27 action IDs + labels (closed list; `track()` only accepts these) | `src/shared/usage.ts` |
| Store: atomic 0600 writes, 1 s debounce, sync flush at quit, corrupt file → moved aside | `src/main/usage/UsageStore.ts` |
| IPC: `usage:track` (one-way, never throws back), `get`, `reset`, `export` (native Save dialog) | `src/main/usage/register.ts` |
| Crash-proof renderer helper | `src/renderer/usage.ts` |
| Settings → Usage table, Refresh / Export JSON / Reset (click twice) | `src/renderer/settings.ts` |

Counted at the gesture (button click, shortcut, tab `+`/`×`, menu actions), not in panel
`toggle()` — that also runs for programmatic opens and would inflate counts.

## 2. Auto-explain errors (opt-in, off by default)

Settings → AI assistant → *Auto-explain errors in the terminal*. When a command's output looks
like a failure, the recent output (≤60 lines) is sent to Groq and the explanation opens in the
Explain panel marked **AUTO**.

- **Detection** (`src/renderer/error-detect.ts`): specific signatures (`command not found`, `No
  such file or directory`, `Permission denied`, segfault, Python tracebacks/`FooError:`, JS stack
  frames, `fatal:`, `npm ERR!`, `error[E…]`, `panic:`, compiler errors, `Error:` lines). ANSI is
  stripped first. Only the fresh chunk is inspected. 500 ms debounce (a trace = one event), 8 s
  cooldown that starts only when an explanation was actually sent.
- **Gates:** the setting is on · the tab is the active one · content may show (not behind the
  protection gate) · no explanation already running · a key is set.
- **Redaction:** in the main process, as for manual Explain.
- **Execution untouched:** a passive, try/caught read of output already shown.
- Shell integration (OSC 133) was rejected: it needs edits to the user's shell startup.

## Verification

**Tests:** 326 pass (+58: 22 usage, 36 auto-explain). Break-tested by reverting each guard:
unknown-ID rejection, load-time filter, quit-flush pending check, stale-write guard, cooldown,
fresh-chunk-only, false-positive resistance, settings backwards-compat, cooldown-on-accept —
each turns a test red.

**Real app** (`INVI_AUTOTEST=…`, temp data dir, stubbed model, no network):

| Run | Result |
|---|---|
| `tabs-settings` | usage.json: newTab 3, prevTab 1, closeTab 1, panel.settings 3 — matches the keypresses; 0600 |
| `auto-explain` | off: nothing sent · on: AUTO marker, no confirm, stream Done · stub got 6 lines, **no planted `gsk_` secret** · cooldown held · shell still runs commands · `ai.autoExplain: 1` |
| `ai-explain` (regression) | preview masks the secret, model never gets it; `ai.explain: 1` recorded ~0.4 s before close |

**Bugs found by the real-app runs (unit tests were green):**
1. With the feature off, ignored detections still started the cooldown, so enabling it and
   failing again within 8 s did nothing. Fixed; regression test added.
2. The quit hook's async flush was cut off by the exit, losing the last second of counts.
   Fixed with a synchronous flush.

**Not verified:** real Groq calls for auto-explain (stub only); the false-positive rate on
real sessions (watch the `ai.autoExplain` count in Settings → Usage).

## Try it

1. Settings → AI assistant → tick **Auto-explain errors** → Save.
2. In the terminal: `frobnicate` (→ command not found). The Explain panel opens with AUTO.
3. Settings → Usage to see the counts.
