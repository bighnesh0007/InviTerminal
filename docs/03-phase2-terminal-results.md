---
type: findings
status: Phase 2 — terminal MVP verified on KDE Plasma 6.7.5 (Wayland); Windows shells not started
verified-on: 2026-10-14
---

# Phase 2 — terminal MVP results

## What was built

- xterm.js 6 terminal (fit addon) bound to one shell via node-pty 1.1.0, running in the
  Electron main process.
- **Shell profiles** come from `/etc/shells` plus `$SHELL`. Non-interactive entries are
  dropped (`git-shell`, `rbash`, `nologin`, `systemd-home-fallback-shell`), and entries
  are deduplicated by *name + realpath*. The **listed path** is what gets spawned: bash
  checks the name it was launched as, so `sh` must start as `sh`.
- **The renderer can only name a profile id.** The file and arguments come from the
  detected table. Every message is zod-validated and sender-checked.
- **The child environment** inherits the user's, minus anything matching `ELECTRON_*`,
  `npm_*` or `INVI_*`, plus `CHROME_DESKTOP` and `ORIGINAL_XDG_CURRENT_DESKTOP`. It adds
  `TERM=xterm-256color`, `COLORTERM=truecolor` and `TERM_PROGRAM=InviTerminal`.
- **Output is batched** (5 ms / 64 KiB) and **flow-controlled**: the renderer acknowledges
  characters after xterm parses them, and the PTY pauses above 100 k unacknowledged
  characters and resumes below 10 k.
- **The protection gate** covers the terminal, and **drops keystrokes**, until the
  compositor confirms exclusion (or the user clicks "Show anyway").
- **Copy and paste:** Ctrl+Shift+C / Ctrl+Shift+V go through the main process's
  clipboard. Paste uses xterm's `paste()`, so bracketed-paste markers apply when the shell
  asked for them.
- **Shell exit** prints the exit code; Enter starts a new shell. **Closing the window
  kills every shell.**

## Verified

| # | Fact | How |
|---|---|---|
| 1 | node-pty 1.1.0 is N-API: **one compiled binary loads in Node 22 (ABI 127) and Electron 44 / Node 24 (ABI 149)**. No `@electron/rebuild` step | Spawned a shell from both runtimes |
| 2 | This machine's profiles: `bash` (default, from `$SHELL`), `sh` | `INVI_AUTOTEST=terminal` |
| 3 | Round-trip through the real renderer: input → bash → IPC → xterm.js | autotest `roundtrip` |
| 4 | The xterm fit size reaches the tty: renderer 121×41 = `stty size` | autotest `resize` |
| 5 | **A 5 MB flood arrives complete and in order** in ~700 ms. The PTY was paused 34–35 times and **in-flight drains to 0** afterwards | autotest `flood`, `acks-drained` (3 runs) |
| 6 | The exit code is reported (3) | autotest `exit` |
| 7 | **No shell outlives the window**: both pids gone after close | `ps -p` from outside, after the app exited (3 runs) |
| 8 | **The gate blocks real keystrokes** while unprotected; the same keystrokes reach the shell after re-protect | `INVI_AUTOTEST=ui-snapshot`: `sendInputEvent` typing |
| 9 | Colour, bold, truecolour, reverse video and a monospace grid render correctly | `capturePage()` snapshot |
| 10 | Phase 1 capture behaviour unchanged with the terminal present (negative control FAIL, PASS, hide/show PASS) | `INVI_AUTOTEST=screenshot` |

## Found and fixed

- **xterm.js needs inline styles.** It builds `<style>` elements at runtime for theme and
  cell metrics, and sets `style` on truecolour cells. It has no nonce support. Under
  `style-src 'self'` the terminal rendered with **no colour, no bold and a proportional
  font**; this was confirmed by snapshot. The CSP now allows `'unsafe-inline'` for **styles
  only**. Scripts stay `'self'`, and `default-src 'none'` means inline CSS cannot fetch
  anything. VS Code makes the same trade.
- **Autotests are disabled in packaged builds** (`app.isPackaged`). They type into a
  real shell and take screenshots.

## Known limitations (not fixed in Phase 2)

| Item | Note |
|---|---|
| The PTY runs in the **main process** | A native crash in node-pty takes the whole app down. Moving it to `utilityProcess` is possible later |
| One session | The manager supports up to 8; tabs come in Phase 5 |
| No multi-line paste confirmation | bash 5.1+ enables bracketed paste, so a paste does not auto-run. A confirmation is planned with the snippet library (Phase 4) |
| CJK glyphs show as boxes | This machine has **no CJK font** (`fc-list :lang=ja` → 0). A system font issue, not the app |
| Windows shells (cmd / PowerShell / WSL) | Not started; Windows is deferred |
| Screen-reader mode is off | It would mirror terminal text into the accessibility tree, readable by other processes |

## Reproduce

```bash
INVI_AUTOTEST=terminal npm start
```

```bash
INVI_AUTOTEST=ui-snapshot INVI_SNAPSHOT_PATH=/tmp/inviterminal-ui.png npm start
```

```bash
INVI_AUTOTEST=screenshot npm start
```
