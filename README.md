# InviTerminal

A developer terminal that **asks the compositor to leave its window out of
screen capture, then checks whether that actually happened**.

It is **not** invisible. It stops content from appearing *by accident* in
mainstream screen shares and recordings on supported desktops. It does nothing
about cameras, remote desktop, compromised machines, accessibility APIs or the
clipboard. See [docs/01-feasibility-and-architecture.md](docs/01-feasibility-and-architecture.md) §2.5.

## Status — Phase 6 (Linux packaging)

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
[Phase 4](docs/05-phase4-library-results.md) ·
[Phase 5](docs/06-phase5-settings-tabs-results.md) ·
[Phase 6](docs/07-phase6-packaging-results.md).

**Settings** (Ctrl+Shift+Comma) live in `settings.json` in the app data directory
(`~/.config/inviterminal/` by default, mode 0600). Font, scrollback, the shell for new
tabs, the shortcuts and the library database apply immediately. Shortcuts are recorded
by pressing them; any that would steal a key the shell needs are refused.

Until packaging, the dev form of `inviterminal` is:
`node_modules/electron/dist/electron /path/to/InviTerminal --toggle`

Default keys (all in-app keys are configurable in Settings):

| Key / command | Action |
|---|---|
| **Ctrl+Shift+H** | Hide now (panic). Also the Hide button and the tray's "Hide now" |
| Ctrl+Shift+T / Ctrl+Shift+W | New tab / close tab (kills its shell) |
| Ctrl+PageDown / Ctrl+PageUp | Next / previous tab |
| Ctrl+Shift+L | Snippet library |
| Ctrl+Shift+Comma | Settings |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste (fixed) |
| `inviterminal --toggle` / `--show` / `--hide` | Control the running window from anywhere; bind `--toggle` in KDE System Settings → Keyboard → Shortcuts → Add New → Command |
| Tray icon click | Show / hide |

## Requirements (Linux)

- KDE Plasma **6.6 or newer**, Wayland session
- `gdbus` (glib2) — used to talk to KWin
- `spectacle` — only for the automatic screenshot self-test
- Node.js 22+, plus `python3`, `make` and `g++` (node-pty compiles from source on Linux)
- MongoDB for the snippet library. Defaults to `mongodb://127.0.0.1:27017/inviterminal`;
  the terminal works without it
- *(optional, AI features)* a **free Groq API key** (console.groq.com; set in Settings) for
  "Explain output" and interview practice; `whisper-cli` + a ggml model for local
  speech-to-text. Audio is transcribed locally and never uploaded; terminal text is sent to
  Groq only after a confirm-preview that masks obvious secrets

## Configuration

Settings are edited in the app (Ctrl+Shift+Comma). These environment variables override
them for a single run, mostly for development:

| Variable | Overrides | Meaning |
|---|---|---|
| `INVI_MONGODB_URI` | Library → MongoDB URI | Must name its own database; non-local hosts are refused… |
| `INVI_MONGODB_ALLOW_REMOTE` | …unless this is `1` | Snippets would leave this machine |
| `INVI_GLOBAL_SHORTCUT` | Global shortcut | Portal shortcut, e.g. `Control+Alt+T`. Works once `inviterminal.desktop` is installed (Arch package, or `scripts/user-desktop-entry.sh install`); KDE asks you to confirm the first time |
| `INVI_USER_DATA_DIR` | — | Use another data directory (settings, single-instance lock); the autotests use a temp one |

## Install

**Arch Linux** (runs on Arch's `electron44`):

```bash
cd packaging/arch && makepkg -f
```

```bash
sudo pacman -U packaging/arch/inviterminal-0.1.0-1-x86_64.pkg.tar.zst
```

Then bind a global key in KDE: System Settings → Shortcuts → InviTerminal → **Show / Hide**.

**AppImage** (any distro). It needs `libfuse.so.2`; without it, use extract-and-run mode:

```bash
npm run dist:linux
```

```bash
APPIMAGE_EXTRACT_AND_RUN=1 release/InviTerminal-0.1.0-x86_64.AppImage
```

`scripts/user-desktop-entry.sh install` adds a per-user menu entry for the AppImage (and
`uninstall` removes only what it added).

## Run from source

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

```bash
INVI_USER_DATA_DIR=$(mktemp -d) INVI_AUTOTEST=tabs-settings npm start
```

That runs tabs and settings with real keystrokes: open/switch/close tabs, settings saved
through the UI, rebinding a shortcut, and invalid shortcuts refused. Every autotest uses a
throwaway `mongod`.

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
  library/           MongoDB store (Mongoose, lazily loaded), URI policy, service/retry, IPC schemas
  settings/          settings.json store (atomic, 0600, corrupt-file handling) + zod schema
  autotest.ts        INVI_AUTOTEST drivers (dev builds only)
  config.ts          the only module that reads environment variables
src/preload/         contextBridge API (sandboxed)
src/renderer/        UI (sandboxed, no Node; CSP: scripts self-only, inline styles allowed for xterm.js)
src/shared/          canary, detector, verdict, keymap rules, settings/snippet types, IPC contract
test/                Vitest; fixtures are recorded from real KWin replies
docs/                feasibility/architecture, Phase 1–6 results, checklist
packaging/arch/      PKGBUILD (system electron44), launcher, .desktop (with Show/Hide action)
build/icons/         app icons 16–512 px (generated by scripts/gen-icons.py)
assets/              tray icon (generated by scripts/gen-icons.py)
```

## License

MIT — see [LICENSE](LICENSE).
