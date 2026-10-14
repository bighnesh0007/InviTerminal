# InviTerminal

A developer terminal that **asks the compositor to leave its window out of
screen capture, then checks whether that actually happened**.

It is **not** invisible. It stops content from appearing *by accident* in
mainstream screen shares and recordings on supported desktops. It does nothing
about cameras, remote desktop, compromised machines, accessibility APIs or the
clipboard. See [docs/01-feasibility-and-architecture.md](docs/01-feasibility-and-architecture.md) §2.5.

## Status — Phase 4 (snippet library)

| Platform | Status |
|---|---|
| KDE Plasma 6.6+ on Wayland | Implemented. Screenshot path verified; portal screencast and Meet **not yet verified** — see [docs/02-phase1-capture-results.md](docs/02-phase1-capture-results.md) |
| X11, GNOME, other compositors | Detected and reported as unsupported |
| Hyprland | Deferred |
| Windows 10/11 | Deferred to a later phase |

The terminal is xterm.js + node-pty, using your `$SHELL` (bash here). It is hidden, and
keystrokes are not sent, until the compositor confirms exclusion. Every hide first covers
the terminal: a re-shown window is a new compositor window that stays capturable for
about 150 ms until protection is re-applied.

The **snippet library** (Ctrl+Shift+L) stores snippets in MongoDB: by default its own
`inviterminal` database on the local server, and never a remote one unless you allow it.
**Insert** pastes into the terminal without a newline, so nothing runs until you press
Enter. Multi-line snippets ask first.

Results: [Phase 2](docs/03-phase2-terminal-results.md) ·
[Phase 3](docs/04-phase3-visibility-results.md) ·
[Phase 4](docs/05-phase4-library-results.md).

Until packaging, the dev form of `inviterminal` is:
`node_modules/electron/dist/electron /path/to/InviTerminal --toggle`

| Key / command | Action |
|---|---|
| **Ctrl+Shift+H** | Hide now (panic). Also the Hide button and the tray's "Hide now" |
| `inviterminal --toggle` / `--show` / `--hide` | Control the running window from anywhere; bind `--toggle` to a key in KDE System Settings → Keyboard → Shortcuts → Add New → Command |
| Tray icon click | Show / hide |
| **Ctrl+Shift+L** | Snippet library: search, insert, copy, edit, delete/undo |
| Ctrl+Shift+C | Copy selection |
| Ctrl+Shift+V | Paste (bracketed when the shell supports it) |
| Ctrl+C | Interrupt (sent to the shell as usual) |
| Enter after exit | Start a new shell |

## Requirements (Linux)

- KDE Plasma **6.6 or newer**, Wayland session
- `gdbus` (glib2) — used to talk to KWin
- `spectacle` — only for the automatic screenshot self-test
- Node.js 22+, plus `python3`, `make` and `g++` (node-pty compiles from source on Linux)
- MongoDB for the snippet library. Defaults to `mongodb://127.0.0.1:27017/inviterminal`;
  the terminal works without it

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `INVI_MONGODB_URI` | `mongodb://127.0.0.1:27017/inviterminal` | Library database. Must name its own database |
| `INVI_MONGODB_ALLOW_REMOTE` | `0` | `1` allows a non-local MongoDB (snippets leave this machine) |
| `INVI_GLOBAL_SHORTCUT` | unset | Opt-in portal global shortcut, e.g. `Control+Alt+T`. **Needs an installed .desktop file on KDE**; see Phase 4 results |

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

```bash
INVI_AUTOTEST=visibility npm start
```

That runs the show/hide checks: CLI toggle from a real second process, tray activation
over D-Bus, Ctrl+Shift+H, and a measurement of the show→re-protect gap.

```bash
INVI_AUTOTEST=library npm start
```

That runs the library checks against a throwaway `mongod`: search, insert (never
executes), multi-line confirmation, copy, edit, delete/undo, and the gate.

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
  visibility/        CLI flags, VisibilityController (cover-then-hide), tray, accelerator check
  library/           MongoDB store (Mongoose), URI policy, service/retry, IPC schemas
  autotest.ts        INVI_AUTOTEST drivers (dev builds only)
  config.ts          the only module that reads environment variables
src/preload/         contextBridge API (sandboxed)
src/renderer/        UI (sandboxed, no Node; CSP: scripts self-only, inline styles allowed for xterm.js)
src/shared/          canary generator, detector, verdict, IPC contract — used by all sides
test/                Vitest; fixtures are recorded from real KWin replies
docs/                feasibility/architecture, Phase 1–4 results, checklist
assets/              tray icon (generated by scripts/gen-tray-icon.py)
```
