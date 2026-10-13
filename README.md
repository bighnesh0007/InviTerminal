# InviTerminal

A developer terminal that **asks the compositor to leave its window out of
screen capture, then checks whether that actually happened**.

It is **not** invisible. It stops content from appearing *by accident* in
mainstream screen shares and recordings on supported desktops. It does nothing
about cameras, remote desktop, compromised machines, accessibility APIs or the
clipboard. See [docs/01-feasibility-and-architecture.md](docs/01-feasibility-and-architecture.md) §2.5.

## Status — Phase 1 (capture-exclusion spike)

| Platform | Status |
|---|---|
| KDE Plasma 6.6+ on Wayland | Implemented. Screenshot path verified; portal screencast and Meet **not yet verified** — see [docs/02-phase1-capture-results.md](docs/02-phase1-capture-results.md) |
| X11, GNOME, other compositors | Detected and reported as unsupported |
| Hyprland | Deferred |
| Windows 10/11 | Deferred to a later phase |

There is no terminal yet; that is Phase 2.

## Requirements (Linux)

- KDE Plasma **6.6 or newer**, Wayland session
- `gdbus` (glib2) — used to talk to KWin
- `spectacle` — only for the automatic screenshot self-test
- Node.js 22+

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

End-to-end self-test against the real compositor (takes screenshots, analyses
them in memory, deletes them, quits):

```bash
INVI_AUTOTEST=screenshot npm start
```

## How protection status is reported

| Badge | Meaning |
|---|---|
| Requested (not confirmed) | The request was sent; it could not be read back |
| Compositor reports excluded | KWin says the flag is set. **No pixels checked** |
| Self-test passed (tested paths only) | A canary in this window was absent from a real capture *and* a canary in an unprotected control window was present |
| SELF-TEST FAILED | This window's content was found in a capture |

Content is hidden until the compositor confirms the flag, unless you click
"Show anyway".

## Layout

```
src/main/            Electron main process (trusted)
  capture/           provider interface, KWin + unsupported providers, controller, self-test
  config.ts          the only module that reads environment variables
src/preload/         contextBridge API (sandboxed)
src/renderer/        UI (sandboxed, strict CSP, no Node)
src/shared/          canary generator, detector, verdict, IPC contract — used by all sides
test/                Vitest; fixtures are recorded from real KWin replies
docs/                feasibility/architecture, Phase 1 results and checklist
```
