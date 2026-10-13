---
type: decision-record
status: accepted 2026-10-14 — see §8 for decisions; Phase 1 results in 02-phase1-capture-results.md
verified-on: 2026-10-14
---

# InviTerminal — feasibility, architecture, roadmap

## Evidence labels

Every platform claim below carries one of these. Only **[LOCAL]** and **[SRC]**
are things I checked myself; nothing here has been runtime-tested yet.

| Label | Meaning |
|---|---|
| **[LOCAL]** | Checked on the dev machine (Arch, KDE Plasma 6.7.5 Wayland, KWin 6.7.5) |
| **[SRC]** | Read in the upstream source at a pinned version |
| **[DOC]** | Vendor documentation |
| **[3P]** | Third-party research |
| **[ASSUME]** | Not verified. A Phase 1 task exists to verify it |

> **Update 2026-10-14:** Phase 1 has since verified several KWin rows on the real
> system — see [02-phase1-capture-results.md](02-phase1-capture-results.md). Hyprland
> and Windows are deferred.

---

## 1. Scope and threat model

**Goal:** stop terminal content, scripts and snippets from appearing *by accident*
when the user shares their screen or records it with mainstream tools such as
Meet, Zoom, Teams, OBS or the OS screenshot tool.

**Not a goal:** hiding content from an adversary who controls the machine, the
display path or the room. No OS offers that, and this app will not claim to.
The UI never says "invisible". It reports which capture paths were *tested* and
the result for each one.

---

## 2. Feasibility by platform

### 2.1 Windows 10/11 — `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`

| Fact | Label |
|---|---|
| `WDA_EXCLUDEFROMCAPTURE` (0x11) requires Windows 10 2004 (build 19041) or later. On older builds the call **behaves like `WDA_MONITOR`**: the window shows as a **black box** instead of being absent | [DOC] |
| It works only while DWM is composing the desktop. That is always the case on Windows 10/11 *except under RDP*, where the window renders normally | [DOC] [3P] |
| Microsoft states it is "not a security feature" and there is "no guarantee" that content is protected | [DOC] |
| It applies to one top-level HWND. Every popup, tooltip, native menu or dialog is a separate HWND and needs its own call, or it leaks | [3P] |
| Cross-process `SetWindowDisplayAffinity` is refused even for admins (an ownership check). Any code injected into our process, however, can clear the flag (the 2026 Signal Desktop bypass) | [3P] |
| A failed call returns FALSE and sets an error, and nothing else reports it. `GetWindowDisplayAffinity` can read the value back | [DOC] |
| Public capture APIs (Windows.Graphics.Capture, DXGI Desktop Duplication, GDI BitBlt) honour it, so Chrome, Edge (and therefore Meet), Teams, Zoom and OBS display capture should omit the window | [DOC] / [ASSUME] per app |
| Capture below DWM (some GPU-vendor recorders, display-driver hooks, kernel drivers) can bypass it | [3P] / [ASSUME] which vendors |
| Electron's `setContentProtection(true)` uses this API but **returns no result** | [DOC] |

**Verdict:** feasible, and the strongest platform. We call the API ourselves
through FFI so we can check the return value and read it back.

### 2.2 Linux / KDE Plasma (KWin) — what you are running now

| Fact | Label |
|---|---|
| The dev machine is KDE Plasma **6.7.5 on Wayland**, not Hyprland | [LOCAL] |
| KWin 6.6+ has a per-window `excludeFromCapture` property. It is a **writable** `Q_PROPERTY` (`window.h:619`) | [SRC] kwin v6.7.5 |
| It can be set by the user (titlebar → More Actions → Hide from Screen Capture), by a window rule (`excludefromcapture` key in `kwinrulesrc`), by a KWin script (since the property is writable), or by privileged plasma-window-management clients such as the taskbar | [SRC] |
| **No client-side Wayland protocol exists.** An app cannot ask for exclusion for itself the way it can on Windows. It has to go through a KWin script over D-Bus, a window rule, or the user | [SRC] [LOCAL] (no such protocol in `libkwin`) |
| It propagates recursively to transient windows (menus, popups) | [SRC] `window.cpp:2158` |
| **Honoured by:** whole-screen (output) and region screencasts (`FilteredSceneView`), and the screenshot plugin. The window is *removed*, so whatever is behind it shows through | [SRC] |
| **Not referenced in `windowscreencastsource.cpp`.** If the user picks "share a window" and chooses *this* window, it may still be shared on 6.7.5 | [SRC] — **must be runtime-tested** |
| Read back with `org.kde.KWin /KWin getWindowInfo(uuid)`, which returns `excludeFromCapture` | [SRC] `dbusinterface.cpp:149` |
| Chrome-based Meet on Wayland captures through xdg-desktop-portal → PipeWire → KWin screencast, so it should be filtered | [ASSUME] |

**Verdict:** feasible, with no self-service API. The plan is a KWin script loaded
over D-Bus that sets the property on our own window. The fallback is a guided
manual toggle or a window rule the user explicitly opts into.

### 2.3 Linux / Hyprland

| Fact | Label |
|---|---|
| Window rule `no_screen_share` (spelled `noscreenshare` before the 0.53 rule-syntax rewrite). The current release is v0.56.2 | [SRC] Hyprland main @ 2026-10-13 |
| **Honoured by:** wlr-screencopy, hyprland-toplevel-export and ext-image-copy-capture. Those three cover the xdg-desktop-portal-hyprland and `grim` paths | [SRC] `ScreenshareFrame.cpp` |
| Behaviour: draws a **black rectangle** over the window and its popups *even if other windows are on top*, so the window's position and size still show in the shared stream. Sharing that window on its own shows a "denied" texture | [SRC] |
| There is no client protocol. The app would add a dynamic rule over the Hyprland IPC socket (`hyprctl keyword windowrule …`), or the user adds a static rule to `hyprland.conf` | [ASSUME] exact runtime syntax and whether it applies to an already-mapped window |
| Readback through `hyprctl getprop` | [ASSUME] |
| I cannot test Hyprland on this machine. Options: run Hyprland nested inside KDE, or test on your Hyprland box | [LOCAL] |

### 2.4 Unsupported Linux environments

The app shows a persistent red warning on these:

- **Any X11 session.** Any X client can read the root window, and there is no
  exclusion mechanism.
- **GNOME/Mutter, Sway and other wlroots compositors.** I found no per-window
  exclusion mechanism, but I didn't investigate exhaustively [ASSUME].
- The app running under **XWayland** inside a supported compositor. We will force
  native Wayland and detect when that fails.

### 2.5 Exposure that no platform API covers

These go in the in-app "Limitations" panel and the README:

1. A camera or phone pointed at the screen, or an HDMI capture card or splitter.
2. RDP or remote-desktop sessions, and a VM whose host is recording.
3. Capture below the compositor (driver hooks, some GPU-vendor recorders) [3P/ASSUME].
4. Malware or anything injected into our process.
5. **Accessibility APIs** (UI Automation / AT-SPI). xterm.js's screen-reader mode
   exposes terminal text to any process that asks.
6. **The clipboard.** Copied snippets reach clipboard managers and, on Windows,
   Clipboard History and Cloud Clipboard. Mitigation: set Windows' documented
   `ExcludeClipboardContentFromMonitorProcessing` and
   `CanIncludeInClipboardHistory=0` formats [DOC]. Electron support for this is [ASSUME].
7. **The window title.** It appears in Meet's and the portal's window pickers, the
   taskbar and Alt-Tab. Use a neutral title.
8. Task-switcher and taskbar live thumbnails [ASSUME behaviour per OS].
9. Logs, crash dumps and saved scrollback. Do not persist scrollback by default.
10. On Hyprland, the black box itself shows where the window is.

---

## 3. Technology stack

| | **Electron + TypeScript** (recommended) | Tauri 2 + Rust | Native Qt6/C++ |
|---|---|---|---|
| Terminal | xterm.js + node-pty: the same stack as VS Code on Windows (ConPTY) and Linux | xterm.js + portable-pty | QTermWidget is Unix-only, so Windows would need its own work |
| Renderer | Chromium on both OSes, so it behaves identically | WebView2 / **WebKitGTK** (xterm.js WebGL quirks on Linux) | Native |
| Capture self-test | `desktopCapturer` is the **same Chromium capture stack Meet uses** | Would need its own PipeWire/WGC client | Its own code |
| Win32 / D-Bus / IPC | koffi FFI, dbus-next, `net` unix socket (all from TS) | windows crate, zbus (excellent) | Excellent |
| Global shortcuts on Wayland | Portal behind a feature flag [ASSUME], plus a CLI-toggle fallback | The plugin is X11-only, so it needs `ashpd` | KGlobalAccel on KDE only |
| Size | ~100–150 MB installed | ~10 MB | Medium |
| Your stack / tooling on this machine | TypeScript; Node 22 is installed | Rust is **not installed** | — |

**Recommendation: Electron.** The deciding point is verification. The in-app
self-test can run the same Chromium screen-capture path that Meet runs in Chrome,
which beats any custom capture code. It also keeps you in strict TypeScript.

The costs, accepted on purpose:

- A large binary.
- Two native modules (node-pty, koffi) that need rebuilding per Electron version.
- A bigger attack surface, handled by the hardening list in §6.

---

## 4. Architecture

### 4.1 Processes

```
┌───────────────────────── main process (Node, trusted) ─────────────────────────┐
│ ProtectionController ─▶ CaptureExclusionProvider (win32-wda | kwin | hyprland | none)
│ PtyManager (node-pty, explicit argv)   LibraryStore (JSON, zod)   Shortcuts   Config
└──────────────▲───────────────────── typed IPC, zod-validated ───────────────────┘
               │ contextBridge (preload: minimal, no Node)
┌──────────────┴── renderer (sandboxed, CSP, no remote content) ──────────────────┐
│ xterm.js terminal │ snippet library │ protection status badge │ settings │ self-test UI
└─────────────────────────────────────────────────────────────────────────────────┘
```

There is one top-level window. All menus, tooltips and dialogs are drawn inside
the DOM, so no unprotected native popup HWNDs or surfaces exist.

### 4.2 The common interface

```ts
// src/main/capture/types.ts
export type ProviderId = 'win32-wda' | 'kwin' | 'hyprland' | 'unsupported';

/** The strongest evidence held so far. Order matters: each step needs the one before it. */
export type ProtectionState =
  | { level: 'unsupported'; reason: string }            // X11, GNOME, Win < 2004 …
  | { level: 'unprotected' }                              // user turned it off, or not applied yet
  | { level: 'request-failed'; error: string }            // API returned failure
  | { level: 'requested' }                                // API said OK; nothing read back yet
  | { level: 'readback-confirmed'; detail: string }       // GetWindowDisplayAffinity / KWin getWindowInfo / hyprctl
  | { level: 'selftest-passed'; paths: SelfTestResult[] } // canary absent AND control canary present
  | { level: 'selftest-failed'; paths: SelfTestResult[] };// canary seen in a capture — loud warning

export interface CaptureExclusionProvider {
  readonly id: ProviderId;
  /** Version / session checks only; no side effects. */
  probe(): Promise<{ supported: boolean; reason?: string; knownGaps: string[] }>;
  apply(win: Electron.BrowserWindow): Promise<{ ok: boolean; error?: string }>;
  readBack(win: Electron.BrowserWindow): Promise<{ excluded: boolean | 'unknown'; detail: string }>;
  remove(win: Electron.BrowserWindow): Promise<void>;
}
```

`ProtectionController` resets to `requested` and re-runs readback whenever any of
these happen: the window is shown or recreated, a display is added or removed,
the user unlocks or resumes, or the compositor restarts. **"selftest-passed" is
stamped with the paths and the time.** It is never treated as permanent.

Provider mechanics:

- **win32-wda:** check that the build is ≥ 19041, call `SetWindowDisplayAffinity`
  through koffi, check the return value and `GetLastError`, then read it back
  with `GetWindowDisplayAffinity`.
- **kwin:** check KWin's version over D-Bus. Write a 10-line KWin script to a
  temporary file. Load it with `org.kde.KWin /Scripting loadScript` and run it;
  it finds our window by pid and sets `excludeFromCapture = true`. Read back with
  `getWindowInfo`. Fallback: show the titlebar instructions, or write a window
  rule only after the user gives explicit consent. **[ASSUME]** that the window's
  pid is Electron's main pid.
- **hyprland:** detect `HYPRLAND_INSTANCE_SIGNATURE`. Send a dynamic rule over the
  IPC socket, matched on our app-id, then read it back. Fallback: print the
  `hyprland.conf` line for the user to add.

### 4.3 Directory layout

```
src/
  main/
    index.ts            lifecycle, single-instance lock, `--toggle` CLI
    config.ts           the one validated config module (zod)
    window.ts           hardened BrowserWindow factory
    ipc/                channel contract + zod validators
    pty/                PtyManager.ts, shells.ts (cmd → pwsh/WSL later; bash/zsh/fish from /etc/shells + $SHELL)
    capture/
      types.ts  detect.ts  ProtectionController.ts
      providers/        win32-wda.ts  kwin.ts  hyprland.ts  unsupported.ts
      selftest/         canary.ts  detect-canary.ts
    library/            store.ts  schema.ts
    shortcuts.ts
  preload/index.ts
  renderer/             terminal/  library/  status/  settings/  selftest/
  shared/               ipc-contract.ts
test/                   vitest unit + fixture frames for the canary detector
docs/                   this file, verification-checklist.md, limitations.md
```

---

## 5. Verification workflow

Evidence is ranked. Each level means only what it says.

1. **API return** — the call didn't fail. That proves nearly nothing.
2. **Readback** — the OS or compositor *says* the flag is set. It still says
   nothing about the pixels.
3. **In-app self-test**, started manually from the UI:
   - The protected window shows a canary pattern: high-saturation cells encoding a
     random nonce.
   - A second, deliberately **unprotected control window** shows a different
     nonce. It is a positive control, so a broken capture or a broken detector
     cannot produce a false pass.
   - The app captures the screen through `desktopCapturer`. That is the Chromium
     path; on Wayland it shows the portal picker, and the user chooses the screen.
     It then scans the frames for both nonces.
   - **Pass only if** the control is found AND the protected canary is not.
   - The result records the path it tested (for example "Chromium/WGC, monitor 1,
     2026-10-14 12:03"). Nothing else counts as a pass.
4. **Manual end-to-end** (`docs/verification-checklist.md`):
   - Join a Meet from a *second device* as a viewer.
   - Share the entire screen, then the window, then a tab, in turn.
   - Use only the canary — never real secrets — while testing.
   - Repeat for Zoom, Teams, OBS, and the OS screenshot tool, on every OS and
     compositor version.
   - Record the results in a table in the repo.

The canary detector is unit-tested against recorded fixture frames, including
**negative fixtures where the canary is present**, so the test has been seen to fail.

---

## 6. Security practices

- **Renderer:**
  - `contextIsolation`, `sandbox`, `nodeIntegration: false`.
  - A strict CSP; no remote URLs.
  - Navigation and `window.open` blocked.
  - Electron fuses: no `RunAsNode`, ASAR integrity on.
- **IPC:**
  - A small, named channel set.
  - Every payload validated with zod at the main-process boundary.
  - The renderer never sends a command line. It sends `{ profileId }`, and main
    resolves that to an argv from a fixed shell table.
- **Shells:**
  - Spawned with explicit argv; no `shell: true`, no string concatenation.
  - The environment is inherited, minus our own variables.
- **Snippets:**
  - "Insert" writes the text into the PTY as a bracketed paste. It **never
    auto-executes**.
  - Pasting multiple lines asks for confirmation.
  - "Copy" uses the clipboard-exclusion formats where the OS supports them.
- **Privilege:**
  - The Windows manifest uses `asInvoker`, and a banner shows if the app is running elevated.
  - On Linux the app refuses to run as root.
  - Never ask for elevation.
- **Storage:**
  - Snippets live in a JSON file under `userData`, with a schema version and
    atomic write-then-rename.
  - Scrollback is not persisted, and terminal content is not logged.
  - A banner warns that snippets are stored in plaintext. OS keychain storage via
    `safeStorage` comes later.

---

## 7. Roadmap. Each phase ends with evidence, not just "it builds"

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0** | This document. You decide on the questions in §8 | Decisions recorded |
| **1 — capture spike** (the riskiest part, so it goes first) | An Electron window with the canary, three providers plus the unsupported one, a status badge, the self-test with a control window, and the manual checklist. **No terminal yet** | A results table with real runs: KDE (this machine, which I can run), Hyprland (nested or your machine), Windows 10 22H2 and 11 (**your machine — I cannot test Windows**). Includes the KWin "share this window" gap |
| **2 — terminal MVP** | xterm.js + node-pty. One session with cmd on Windows and `$SHELL` on Linux; resize and exit handling | Vitest for shell detection and IPC validation; a manual smoke test on both OSes |
| **3 — show/hide** | Tray, a panic-hide key, Windows `globalShortcut`, a Linux `inviterminal --toggle` CLI (bind it in Hyprland or KDE), and the portal shortcut if Phase 1 verifies it | Toggle works on each target |
| **4 — snippet library** | CRUD, tags and folders, fuzzy search, insert and copy | Store round-trip and migration tests |
| **5 — settings and profiles** | PowerShell and WSL profiles, configurable shortcuts, tabs | — |
| **6 — packaging** | electron-builder: NSIS **per-user** (no admin), AppImage, an Arch `PKGBUILD` | A clean-VM install test on each OS |

**MVP = Phases 1–3.**

---

## 8. Decisions (recorded 2026-10-14)

1. **Stack: Electron.** Accepted.
2. **Hyprland: deferred.** It is not installed on the development machine; we build for what this
   machine runs (KDE Plasma 6.7.5, Wayland) first.
3. **Windows: deferred** to a later phase. The interface keeps room for a `win32-wda` provider.
4. **KWin mechanism: one-shot KWin script over D-Bus**, re-applied whenever the window is shown.
   Window rules (persistent config) were not chosen.

Changed during implementation:

- **No D-Bus library.** `dbus-next` (the obvious JS choice) pulls in `usocket` → `node-gyp` →
  `request` with open critical advisories, plus a native build. KWin is driven through the
  `gdbus` CLI with an explicit argv instead; replies are parsed by small, fixture-tested readers.
- **Window identity** is pid + exact caption via `WindowsRunner.Match` → `getWindowInfo`, so the
  title never has to change (a temporary marker title would flash in screen-share pickers).

## Sources

- Microsoft — [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)
- IOActive — [The DRM flag that isn't DRM](https://www.ioactive.com/the-drm-flag-that-isnt-drm/); [Signal Desktop contentProtection bypass](https://www.ioactive.com/signal-windows-desktop-contentprotection-bypass)
- KWin — [MR 8442 (exclude from capture)](https://invent.kde.org/plasma/kwin/-/merge_requests/8442), [MR 9171 (screenshots)](https://invent.kde.org/plasma/kwin/-/merge_requests/9171); source at tag `v6.7.5`
- Hyprland — [Window Rules wiki (0.51)](https://wiki.hypr.land/0.51.0/Configuring/Window-Rules/); source at `main` 1bd31aa (2026-10-13)
- [Linuxiac — Plasma 6.6 per-window exclusion](https://linuxiac.com/kde-plasma-6-6-will-introduces-per-window-screen-recording-exclusions/)
