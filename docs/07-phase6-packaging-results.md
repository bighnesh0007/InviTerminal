---
type: findings
status: Phase 6 — AppImage and Arch package built and verified without installing; portal-shortcut test awaits a desktop entry
verified-on: 2026-10-14
---

# Phase 6 — packaging (Linux)

## What is produced

| Artifact | How | Size |
|---|---|---|
| `release/InviTerminal-0.1.0-x86_64.AppImage` | `npm run dist:linux` (electron-builder 26.15.3, bundled Electron 44.7.1) | 127 MB |
| `release/linux-unpacked/` | same command (`dir` target) | 293 MB |
| `packaging/arch/inviterminal-0.1.0-1-x86_64.pkg.tar.zst` | `cd packaging/arch && makepkg -f`, against **system `electron44`** (your choice) | 1.8 MB, 10.3 MB installed |

**Arch package layout:**
- `/usr/bin/inviterminal` runs `exec /usr/bin/electron44 /usr/lib/inviterminal/app.asar "$@"`;
- `app.asar` plus `app.asar.unpacked/node_modules/node-pty` (only `build/Release/pty.node`
  as native code);
- `/usr/share/applications/inviterminal.desktop`, with a **Show / Hide desktop action**
  (`--toggle`) that KDE can bind to a key directly;
- hicolor icons from 16 to 512 px, and the README.

**Dependencies:** `electron44 glib2 glibc gcc-libs`.
- `electron44`, not the `electron` meta-package, so an Arch move to Electron 45 can't
  silently change the runtime.
- Optional: `kwin`, `mongodb`, `spectacle`.
- `license=('MIT')`; the package installs `/usr/share/licenses/inviterminal/LICENSE`
  (chosen 2026-10-14).

## Changes made for packaging

- **Production detection no longer trusts `app.isPackaged`.** Under
  `electron44 app.asar`, `isPackaged` is false. `isProductionBuild()` also treats any
  `.asar` path as production. This gates the autotests, DevTools and dev console
  forwarding.
- **`app.setName('inviterminal')`** pins the data directory, the single-instance lock and
  the app ID however the app is launched. Setting `productName` in `package.json` would
  have moved settings to `~/.config/InviTerminal`. It is set only in the electron-builder
  config, for display.
- **Runtime dependencies are just `mongoose` and `node-pty`.** xterm and zod are bundled
  and moved to devDependencies.
- **node-pty's sources and other-platform prebuilds are excluded**, and so is
  auto-update metadata (`publish: null`).
- **Icons** are generated at all sizes by `scripts/gen-icons.py` (stdlib only).
- **`scripts/user-desktop-entry.sh install|uninstall`** writes a per-user desktop entry
  and icons for the AppImage or a dev checkout. It never overwrites an entry it didn't
  create (marker line), and only rebuilds KDE's menu cache when writing to the real data
  directory.

## Verified (no hooks: KWin, process tree and a throwaway `mongod` on :27999, checked from outside)

| Check | unpacked build | AppImage* | Arch package layout** |
|---|---|---|---|
| KWin reports the window with `excludeFromCapture=true`, `desktopFile=inviterminal` | ✔ | ✔ (2.4 s after launch, incl. extraction) | ✔ |
| A bash child spawns (node-pty loaded from `app.asar.unpacked`) | ✔ | ✔ | ✔ |
| The library connects (Mongoose from inside `app.asar`; collection and 4 indexes created) | ✔ | ✔ | ✔ |
| `INVI_AUTOTEST=terminal` is **ignored** | ✔ | — | ✔, with `app.isPackaged` false |
| `--toggle` hides (window gone from KWin), and again shows it protected on a new uuid | ✔ | — | ✔ (through the launcher) |
| SIGTERM: app exits, shell gone | ✔ | ✔ | ✔ |
| `makepkg` `check()` runs the full suite in a clean copy | — | — | **147/147** |

\* **The AppImage needs `libfuse.so.2`** (it fails here: only fuse3 is installed). It runs
with `APPIMAGE_EXTRACT_AND_RUN=1`, and that mode was verified. The user-desktop-entry
script picks it automatically.
\*\* The package's files were extracted to a temp root and run through a copy of its
launcher, with Electron 44.7.1 standing in for `/usr/bin/electron44`, **which is not
installed**. Running the installed package on a real `electron44` is not yet verified.

**Negative control for the production gate:** with `isProductionBuild()` reverted to
`app.isPackaged` only, the same layout **entered autotest mode** (7 autotest lines,
including typing into a real shell). With the fix: **0**. The first attempt at this
mutation didn't apply (a `sed` escaping slip) and tested unchanged code. That was
caught, and redone with an asserted replacement.

**Not verified on the packaged build:** visual rendering. Production builds don't
forward renderer console output, so "0 renderer errors" from them is vacuous. The bundle
is byte-for-byte the one tested in development.

## Supply chain

- `npm audit --omit=dev` (shipped dependencies): **0 vulnerabilities**.
- Full audit: **1 moderate**, `sprintf-js` (DoS through precision specifiers), reached
  through electron-builder → `@electron/get` → `global-agent` → `roarr`. Build-time only;
  the format strings are not attacker-controlled. The offered "fix" downgrades
  electron-builder. **Accepted and documented.**
- The build downloaded Electron 44.7.1 and electron-builder's AppImage and 7zip tools
  from their official GitHub releases (cached under `~/.cache`).

## Incidents during testing (disclosed)

- A process lookup by `pgrep -f inviterminal` matched **my own tool shell**, because its
  command line contained the word, and the script sent it SIGTERM. Nothing of yours was
  affected. The throwaway `mongod` it left on :27999 was found and shut down. Later
  checks identify the app by the pid KWin reports for its window.
- Testing the desktop-entry script with a throwaway `XDG_DATA_HOME` made `kbuildsycoca6`
  create a **new** KDE menu-cache file in `~/.cache`, keyed to that folder. Your existing
  cache was untouched (its creation time was 11:04, unchanged). The new file was
  deleted, and the script no longer rebuilds the cache for non-default data folders.

## Still to do

- **Portal global shortcut test.** It needs an installed `inviterminal.desktop`, through
  either:
  - (a) `scripts/user-desktop-entry.sh install` (writes `~/.local/share/applications`,
    user-level); or
  - (b) installing the Arch package (`sudo pacman -U …`, which also pulls `electron44`).

  Both need your approval, and you at the screen for KDE's dialog.
- **Windows packaging** (NSIS, per-user) with the Windows phase.
