---
type: findings
status: Phase 3 — show/hide, tray, panic-hide and CLI toggle verified on KDE Plasma 6.7.5 (Wayland)
verified-on: 2026-10-14
---

# Phase 3 — visibility results

## What was built

| Control | How |
|---|---|
| **Toggle / show / hide from anywhere** | `inviterminal --toggle` / `--show` / `--hide`. A second process hands the flag to the running instance through Electron's single-instance lock, then exits. Only those exact flags are recognised. |
| **Panic hide** | **Ctrl+Shift+H** (handled before xterm.js sees it, so it never reaches the shell), the **Hide** button, or the tray's **Hide now** |
| **Tray** | A StatusNotifierItem with Show / Hide, Hide now and Quit. Left-click toggles. The tooltip is just "InviTerminal" |
| **Cover before hide** | Every hide first tells the renderer to cover the terminal and waits for it to confirm the cover was painted. The wait is 300 ms, or 80 ms for panic; after that the window is hidden regardless. The cover stays up after the next show until protection has been re-applied *after* the hide |

### Binding a global key in KDE

The app does not register global shortcuts itself (see "Not done" below). Bind the CLI
in KDE instead:

1. Open System Settings → Keyboard → Shortcuts → **Add New → Command or Script**.
2. Set the command to `inviterminal --toggle`. Until packaging (Phase 6), use the dev
   command:
   `/path/to/InviTerminal/node_modules/electron/dist/electron /path/to/InviTerminal --toggle`
3. Pick any key.

## Verified (live, `INVI_AUTOTEST=visibility`)

| # | Fact | Result |
|---|---|---|
| 1 | `--toggle`, `--toggle`, `--hide`, `--show` from a **real second process** | hidden → shown → hidden → shown; about 190 ms each, including the second process's start-up |
| 2 | A window shown by the CLI gets keyboard focus | `isFocused() = true` |
| 3 | The tray is registered with Plasma's StatusNotifierWatcher; `Activate` (what a panel click calls) toggles | hidden after activate |
| 4 | Ctrl+Shift+H, sent as real keystrokes | hidden in **51 ms** |
| 5 | The cover is painted before hide | `concealed: true`, 6 ms |
| 6 | **The gap is real.** After show, KWin first reports the new window at **~75 ms with `excludeFromCapture=false`**; the flag first reads `true` at **~222 ms**. Three runs, ±3 ms | direct `getWindowInfo` poll, independent of the controller |
| 7 | **The cover covers it.** At ~27 ms after show, the window's own frame shows the cover, not the terminal | `capturePage()` with the shell-printed canary: `false`. With the cover disabled, three runs: **`true`** |
| 8 | Content returns once protection is re-confirmed | canary visible again; level `readback-confirmed` |
| 9 | Spectacle captures across the 2.5 s after show: shell canary absent, control canary present | 5 of 5 per run |

### What the Spectacle captures do *not* prove

Spectacle was run with the cover **disabled** as an experiment (3 runs × 5 captures).
It **never caught the terminal either**. Each capture takes about 500 ms, and the grab
itself lands after the ~222 ms gap has closed. Spectacle is too slow to observe this gap,
so its clean results above are not evidence for the cover.

The evidence for the cover is facts 6 and 7 together:
- KWin says the window is capturable for about 150 ms.
- The window's own frame during that time is the cover.

A continuous 30–60 fps screencast, such as Meet, *would* sample inside the gap. That is
why the cover matters.

## Not done in Phase 3

| Item | Why |
|---|---|
| **Portal global shortcuts** (`GlobalShortcutsPortal`) | KDE's portal supports them (GlobalShortcuts v2), and Electron 44 has the feature. But binding shows a KDE dialog and **persists the shortcut into `kglobalshortcutsrc`**: a change to your desktop config, and a step needing a click. Other apps report portal shortcuts dropping after restarts. **Left for a decision.** |
| Windows global hotkey (`RegisterHotKey`) | Windows is deferred |
| Hide on blur, start hidden, autostart | Not in scope |
| The cover is itself visible during the gap | It shows only neutral text ("Terminal hidden until…"), but a viewer can see *that* a window appeared |

## Reproduce

```bash
INVI_AUTOTEST=visibility npm start
```
