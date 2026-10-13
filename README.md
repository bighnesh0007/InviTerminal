# InviTerminal

A developer terminal that **asks the compositor to leave its window out of
screen capture, then checks whether that actually happened**.

It is **not** invisible. It stops content from appearing *by accident* in
mainstream screen shares and recordings on supported desktops. It does nothing
about cameras, remote desktop, compromised machines, accessibility APIs or the
clipboard. See [docs/01-feasibility-and-architecture.md](docs/01-feasibility-and-architecture.md) §2.5.

## Status — Phase 2 (terminal MVP)

| Platform | Status |
|---|---|
| KDE Plasma 6.6+ on Wayland | Implemented. Screenshot path verified; portal screencast and Meet **not yet verified** — see [docs/02-phase1-capture-results.md](docs/02-phase1-capture-results.md) |
| X11, GNOME, other compositors | Detected and reported as unsupported |
| Hyprland | Deferred |
| Windows 10/11 | Deferred to a later phase |

Phase 2 added the terminal: xterm.js + node-pty, using your `$SHELL` (bash here). It is
hidden, and keystrokes are not sent, until the compositor confirms exclusion. Results:
[docs/03-phase2-terminal-results.md](docs/03-phase2-terminal-results.md).

| Key | Action |
|---|---|
| Ctrl+Shift+C | Copy selection |
| Ctrl+Shift+V | Paste (bracketed when the shell supports it) |
| Ctrl+C | Interrupt (sent to the shell as usual) |
| Enter after exit | Start a new shell |

## Requirements (Linux)

- KDE Plasma **6.6 or newer**, Wayland session
- `gdbus` (glib2) — used to talk to KWin
- `spectacle` — only for the automatic screenshot self-test
- Node.js 22+, plus `python3`, `make` and `g++` (node-pty compiles from source on Linux)

## Run

```bash
npm install
```

```bash
npm start
```

## Check

```bash
npm run check
```

That runs the TypeScript strict typecheck and the Vitest suite. The detector,
verdict, KWin parser, environment and controller tests have each been
deliberately broken once to confirm they fail.

End-to-end checks against the real system. They are development builds only, and each
quits when done:

```bash
INVI_AUTOTEST=screenshot npm start
```

That runs the capture self-test: a negative control, then the protected test, then
hide/show. Screenshots are analysed in memory and deleted.

```bash
INVI_AUTOTEST=terminal npm start
```

That runs the real shell checks: round-trip, resize, a 5 MB flood with flow control, the
exit code, and no shells left after close.

## How protection status is reported

| Badge | Meaning |
|---|---|
| Requested (not confirmed) | The request was sent; it could not be read back |
| Excluded per compositor (pixels not tested) | KWin says the flag is set. **No pixels checked** |
| Self-test passed (tested paths only) | A canary in this window was absent from a real capture *and* a canary in an unprotected control window was present |
| SELF-TEST FAILED | This window's content was found in a capture |

Content is hidden until the compositor confirms the flag, unless you click
"Show anyway".

## Layout

```
src/main/            Electron main process (trusted)
  capture/           provider interface, KWin + unsupported providers, controller, self-test
  terminal/          shell detection, child env, PtyManager + flow control, IPC schemas
  autotest.ts        INVI_AUTOTEST drivers (dev builds only)
  config.ts          the only module that reads environment variables
src/preload/         contextBridge API (sandboxed)
src/renderer/        UI (sandboxed, no Node; CSP: scripts self-only, inline styles allowed for xterm.js)
src/shared/          canary generator, detector, verdict, IPC contract — used by all sides
test/                Vitest; fixtures are recorded from real KWin replies
docs/                feasibility/architecture, Phase 1 + 2 results, checklist
```
