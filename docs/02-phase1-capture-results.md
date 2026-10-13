---
type: findings
status: Phase 1 — KDE screenshot path verified; portal screencast and Meet NOT yet verified
verified-on: 2026-10-14
---

# Phase 1 — capture-exclusion results

Target system for this phase (checked with `pacman -Q`, `qdbus6`, env):

| | |
|---|---|
| OS | Arch Linux (rolling), kernel 7.2.6-arch2-1 |
| Desktop | KDE Plasma 6.7.5, **Wayland** session, KWin 6.7.5 |
| Capture stack | PipeWire 1.6.8, xdg-desktop-portal 1.22.1, xdg-desktop-portal-kde 6.7.5 |
| GPU | AMD Cezanne (Radeon Vega, integrated) |
| Display | 1920×1200 single output |
| Browsers for Meet | Google Chrome 149, Brave 153, Firefox 156 |
| Hyprland | **not installed — deferred** (per decision 2026-10-14) |
| Windows | **deferred to a later phase** |

## Verified facts

| # | Fact | How it was verified |
|---|---|---|
| 1 | Electron 44.7.1 runs as a **native Wayland client** here (no XWayland) | Main process's unix sockets peer with `/run/user/1000/wayland-0`; none with `/tmp/.X11-unix` |
| 2 | KWin's window pid is Electron's **main** process pid | `getWindowInfo` `pid` == `process.pid` |
| 3 | KWin's `resourceClass` is `inviterminal` (from `package.json` `name`) | `getWindowInfo` |
| 4 | A KWin script loaded over D-Bus (`/Scripting loadScript` → `/Scripting/Script<id> run`) can set `excludeFromCapture` on our window, and it **stays set after the script is unloaded** | `getWindowInfo` readback → `true` after `unloadScript` |
| 5 | `WindowsRunner.Match` + `getWindowInfo` give an independent readback without any D-Bus library | Recorded fixtures in `test/fixtures/` |
| 6 | **KWin screenshot path** (Spectacle `--background --fullscreen`) omits the excluded window | Autotest: unprotected → canary FOUND (negative control FAIL ✔); protected → control found, protected absent (PASS). **6 of 6 runs** |
| 7 | Hiding and re-showing the window creates a **new KWin window** (new uuid) with the flag cleared; the app's re-apply on `show` restores it | Autotest: uuid changed, readback `true`, screenshot self-test PASS |
| 8 | `nativeImage.toBitmap()` returns **BGRA** on this system | Control canary only matched with BGRA order |

Reproduce 6–8:

```bash
INVI_AUTOTEST=screenshot npm start
```

Expected log: `negative-control … "verdict":"fail"`, then `protected-test … "verdict":"pass"`,
then `after-show-test … "verdict":"pass"`. If the negative control does not FAIL,
the detector is not seeing real captures and the PASS lines mean nothing.

## NOT yet verified — needs a person at the screen

| Path | Why it matters | Status |
|---|---|---|
| **Portal screencast, entire screen** (in-app button "Self-test: screen share (portal)") | Same xdg-desktop-portal → PipeWire → KWin route Chrome/Meet use | **Not run** — requires picking the screen in the KDE portal dialog |
| **Portal screencast, this window only** | KWin 6.7.5 source does *not* filter `windowscreencastsource.cpp`; I expect this to **show the window** | **Not run** |
| Google Meet in Chrome, entire screen, viewed from a second device | The real end-to-end | **Not run** |
| Google Meet, "a window" → InviTerminal | Same expected gap as above | **Not run** |
| Google Meet, "a tab" | Should be unaffected (tab capture is in-browser) | **Not run** |
| OBS (PipeWire screen capture) | Common recorder | OBS not installed |
| Gap between `show` and re-apply after hide/show | Window may be capturable for a few hundred ms | **Not measured** — mitigation planned in Phase 3 (blank content before hide) |

## Manual verification checklist

Use only the canary or dummy text while testing — never real secrets.

1. `npm start`. The badge should read "Compositor reports excluded (pixels not yet tested)".
2. Click **Self-test: screenshot (automatic)** → expect PASS.
3. Click **Remove protection**, run the screenshot self-test again → expect **FAIL**
   (this proves the test can fail). Click **Apply protection**.
4. Click **Self-test: screen share (portal)** → in the KDE dialog pick the **screen**
   → expect PASS. Record the result below.
5. Google Meet (Chrome) from this machine, joined from a **second device** as viewer:
   1. Present → *Entire screen*. On the viewer, the InviTerminal window should be
      absent (you see what is behind it). The control window is not involved here —
      open any other window as your reference.
   2. Present → *A window* → pick InviTerminal. Record what the viewer sees.
   3. Present → *A tab*. InviTerminal should not appear (it is not a tab).
6. In KWin, right-click the InviTerminal titlebar → More Actions → toggle
   "Hide from Screen Capture" off. Within 10 s the badge should turn red
   ("no longer reports this window as excluded") and the content should hide.

### Results log

| Date | Path | Result | Notes |
|---|---|---|---|
| 2026-10-14 | KWin screenshot (Spectacle), automated | PASS ×6, negative control FAIL ×6 | Fact 6 |
| 2026-10-14 | Hide → show → re-apply → screenshot | PASS | Fact 7 |
| | Portal screencast, entire screen | | |
| | Portal screencast, window | | |
| | Meet, entire screen | | |
| | Meet, window | | |
| | Meet, tab | | |
