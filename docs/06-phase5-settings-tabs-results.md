---
type: findings
status: Phase 5 — settings, configurable shortcuts, tabs verified on KDE Plasma 6.7.5; Windows profile slots logic-only
verified-on: 2026-10-14
---

# Phase 5 — settings, shortcuts, tabs, profile slots

## Decisions

- **The PTY stays in the main process.** This was your call on 2026-10-14. A node-pty
  crash would close every tab; revisit if one is ever seen.
- **Settings are stored in `settings.json` in the app data directory, not MongoDB.**
  They include the MongoDB URI itself, and they must load when MongoDB is down.
  - The file is validated by a zod schema; unknown keys are refused.
  - Writes are atomic (temp file + rename) with mode `0600`.
  - An unreadable file is moved to `settings.json.corrupt-<time>`, never overwritten,
    and the UI says so.
- **Environment variables override the file for one run** (`INVI_MONGODB_URI`,
  `INVI_MONGODB_ALLOW_REMOTE`, `INVI_GLOBAL_SHORTCUT`). The settings panel shows those
  fields as set by the environment and won't edit them.
- **`INVI_USER_DATA_DIR`** points the app at another data directory. Every autotest uses
  a temp one, so your real settings are never touched; `~/.config/inviterminal/settings.json`
  still does not exist.

## What was built

| Area | Details |
|---|---|
| Settings panel (Ctrl+Shift+Comma) | Font size, scrollback, shell for new tabs, the seven shortcuts, MongoDB URI and allow-remote, and the portal global shortcut. Font, scrollback, shortcuts and the default shell apply **live**; a MongoDB change **reconnects** the library; the global shortcut is flagged **restart required** |
| Shortcut fields | Click a field and press the keys. **Esc** cancels the recording |
| Shortcut rules (`chordProblem`) | Refused: no modifier; Ctrl+letter, digit or punctuation (control characters); Ctrl+arrows/Home/End (readline); Alt+key except F-keys (readline Meta bindings); Shift+key (typing, scrollback); the reserved Ctrl+Shift+C/V; duplicates. The same rules run in the panel (as you type) and in main (authoritative) |
| Tabs | Ctrl+Shift+T new, Ctrl+Shift+W close (kills its shell), Ctrl+PageDown/PageUp switch, a "+" button with a profile picker. Inactive tabs keep receiving output. Closing the last tab opens a fresh one |
| Keymap dispatch | One capture-phase listener maps physical keys (`KeyboardEvent.code`) to actions, so app shortcuts never reach the shell, on any keyboard layout |
| Windows profile slots | `cmd` (default, per the brief), Windows PowerShell, `pwsh` when installed, and one profile per WSL distro (`wsl.exe -d <name>`, names validated, UTF-16LE `--list --quiet` parsed). **Logic only: unit-tested with fakes, never run on Windows** |

## Verified

| Check | Result |
|---|---|
| Unit tests | **147 passing**, 17 files: keymap rules and matching, settings store (defaults without writing, atomic 0600 writes and reload, invalid patch leaves memory and file untouched, corrupt file moved aside, env overrides not persisted, restart flag, concurrent updates), Windows profile logic |
| Mutation checks | Ctrl+letter allowed, Alt+letter allowed, duplicates allowed, Ctrl+Shift+C allowed, corrupt file overwritten, env override ignored, refused URI saved, world-readable file (0644), junk WSL names accepted: **all caught**. Not covered: that the write is atomic; the test sees no temp files and 0600, not a torn write |
| **Live (`INVI_AUTOTEST=tabs-settings`, real keystrokes, temp data dir):** Ctrl+Shift+T ×2 | 3 tabs, 3 distinct shells |
| Typing | reaches only the active tab |
| Ctrl+PageUp | switches to the previous tab |
| Ctrl+Shift+W | its shell is gone; the other tab gets the keys |
| Settings via the UI | font 18 applied (`.xterm-rows` = 18px); Ctrl+Alt+N recorded by key press; default shell `sh`; the file holds all three |
| Old chord after rebinding | **dead**: focus verified in the terminal first |
| New chord after rebinding | opens a tab, with `sh` |
| Ctrl+C as a shortcut | refused by the panel ("reaches the shell…") and by main with the panel bypassed; an extra key in the patch is refused; file unchanged |
| **Second launch** on the same data dir (`settings-readback`) | first tab opens `sh`; font 18; Ctrl+Alt+N persisted |
| Regression | capture (negative control FAIL → PASS → after-show PASS), terminal (round-trip, resize, flood, exit, no orphans), visibility, library (all steps): **pass** |

## Found and fixed while testing

1. **A shortcut field kept focus after Save and swallowed every later key.** That
   includes the shortcut meant to *close* the panel, which was simply recorded into the
   field. It also made my first "old chord is dead" result vacuous. Fixes:
   - Save releases focus;
   - Esc cancels recording;
   - closing a panel hands focus back to the terminal;
   - the autotest now records where focus was before pressing chords.
2. **The CLI child took its own single-instance lock.** It ran without the parent's
   `INVI_USER_DATA_DIR` and started a second app. This was harness-only; the child now
   gets the same data dir.
3. **Hotkey latency regression, partly fixed.** The `--toggle` second process went from
   ~190 ms (Phase 3) to ~400 ms, because it parsed the bundled Mongoose before learning
   the app was already running. Loading Mongoose lazily, and leaving it out of the
   bundle (main bundle 3.7 MB → 863 KB), brought it to **~225–280 ms**. That is still
   above Phase 3; the rest is unexplained.

## Measured, not fixed

- **The show → re-protect gap varies more than in Phase 3.**
  - Phase 3: 222 ± 3 ms.
  - Phase 5: **160–466 ms** across 7 runs.
  - It is the same with and without the throwaway `mongod` (A/B: 182/290 vs 186/299).
  - The cover still covers it: the renderer showed the cover at ~35 ms after show.
  - The cause is not known yet.
