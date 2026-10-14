---
type: findings
status: Phase 4 — snippet library on MongoDB verified on KDE Plasma 6.7.5; portal shortcuts blocked on a .desktop file
verified-on: 2026-10-14
---

# Phase 4 — snippet library (MongoDB) and portal shortcuts

## Snippet library

**Storage: MongoDB**, by decision on 2026-10-14. The development machine already runs
`mongodb80-bin` 8.0.15 as a systemd service on `127.0.0.1:27017`. That server is
**shared with other projects** (`dwcode`, `gateway_dev`, …) and runs **without auth**.

| Safeguard | How |
|---|---|
| Its own database | Default `mongodb://127.0.0.1:27017/inviterminal`. `admin`, `local` and `config` are refused, and a URI without a database name is refused |
| Snippets stay on this machine | A non-loopback host, or any `mongodb+srv://`, is **refused** unless `INVI_MONGODB_ALLOW_REMOTE=1`. Credentials never appear in the UI; it shows only host/db |
| No accidental index writes | `autoIndex: false`, `autoCreate: false`. The collection and indexes are created explicitly, and only after the URI passes the check |
| A private connection | `mongoose.createConnection`, not the global default |
| Validated input | zod `.strict()` at the IPC boundary; the Mongoose schema uses `strict: 'throw'`. Fields are copied one by one, never spread into the model. IDs must be 24 hex characters, so `{ $ne: null }`-style operators cannot get in |
| Literal search | User text is regex-escaped before it reaches `$regex`. An unescaped `(` would otherwise break the query, and a crafted pattern could ReDoS `mongod` |
| No hard deletes | Delete moves a snippet to trash (`deletedAt`), with Undo and a Trash view to restore |
| Tests never touch the shared server | They run `mongodb-memory-server-core` with **your `/usr/bin/mongod`**, on a random port and a temp dir. Nothing on `:27017` is created or dropped by tests |
| The terminal survives MongoDB being down | Connection failures become "Library unavailable — reason [Retry]" |

**Features:**
- Search across title, tags, folder, description and body, ranked: title prefix,
  then title, tags, folder, description, body; ties go to most used, then most recent.
- Folders (nested, `a/b`) with a filter, and tags.
- **New / Edit / Delete / Undo / Restore.**
- **Copy** puts the body on the clipboard.
- **Insert** pastes into the terminal through xterm's `paste()`. It is bracketed when the
  shell enabled bracketed paste, and **never carries a trailing newline, so inserting
  never runs anything**.
- **Multi-line snippets need a confirmation** that shows a preview first. You didn't
  choose either way, so this is the safer default.
- Ctrl+Shift+L toggles the panel. The panel sits behind the protection gate and the
  hide cover, like the terminal.

### Verified

| Check | Result |
|---|---|
| Store against a real `mongod` (11 tests): create/normalise, invalid docs rejected, smuggled fields ignored, literal search incl. `$(`, folder/tag filters, update, trash/restore, use count, malformed ids, fail-fast when down | ✔ |
| URI policy, normalisation, ranking, `textForInsert`, IPC schemas incl. NoSQL-operator payloads, service status/retry | ✔ (131 tests total) |
| **Live UI** (`INVI_AUTOTEST=library`, real renderer, throwaway mongod): search lists exactly the matches | ✔ |
| Single-line Insert: reaches the PTY, **no newline, not executed**; Enter then runs it | ✔ |
| Multi-line Insert: confirmation shown; **0 bytes** written before confirming and after Cancel; confirm sends `ESC[200~…ESC[201~` with no trailing newline; not executed; Enter then runs both lines | ✔ |
| Copy, Edit (stored), Delete then Undo | ✔ |
| Protection removed: library `visibility: hidden`, gate shown | ✔ |
| The shared server: one read-only `ping` (24 ms) | ✔ |

### Found while testing

- **A vacuous check in my own autotest.** The first "not executed" check looked for
  `\n<marker>\n`. After Enter, bash prints `ESC[?2004l\r<marker>`, with no `\n`, so the
  check **could never have reported execution**. It was replaced by an ANSI-stripped
  whole-line match. Each "not executed" result now has a paired "Enter runs it" positive
  control, using the same detector.
- **Three mutations survived at first:**
  - unescaped regex (the in-app ranking masked it);
  - non-strict schema (unreachable through the store's API);
  - first-`@` URI host parsing (both versions refused the hostile URI).

  Tests were added that kill all three.
- **Electron 44's clipboard API is async** (`readText()`/`write()` return Promises). The
  library autotest saves the clipboard with `clipboard.read()` (all formats) and restores
  it afterwards.
- **One `inconclusive`** in 4 runs of the capture regression: the control window was not
  found in one screenshot, probably covered by something. It was reported as
  inconclusive, not pass, which is the control doing its job. The next 3 runs passed.

### Side effect on the shared server (disclosed)

The first normal launch after the library was wired in, during a SIGTERM check, created
the `inviterminal` database on `:27017`. It holds one empty `snippets` collection and 4
indexes (`_id_`, `deletedAt_1_updatedAt_-1`, `folder_1`, `tags_1`), with 0 documents.
This is what every normal launch does; nothing else on the server was touched.

## Portal global shortcuts — implemented, **not working yet**

- **Implemented** as an opt-in: `INVI_GLOBAL_SHORTCUT="Control+Alt+T"`. Validation needs
  a modifier. On Wayland it enables Chromium's `GlobalShortcutsPortal`.
- **Live result:**
  - `globalShortcut.register()` returned **`true`**;
  - the shortcut **never fired** in 3 minutes;
  - `~/.config/kglobalshortcutsrc` was **unchanged** (diffed against a backup taken
    first).
- **Why**, from a D-Bus trace filtered to the portal interfaces:
  - Chromium calls `GlobalShortcuts.CreateSession`, then nothing: **no `Response`, no
    `BindShortcuts`**.
  - Chromium logs `Failed to register with org.freedesktop.host.portal.Registry`. An
    unsandboxed app is identified to the portal by an app ID backed by an installed
    `.desktop` file, which a dev checkout does not have.
- **To make it work:** install `inviterminal.desktop`. That happens with packaging
  (Phase 6), or earlier into `~/.local/share/applications`, which needs your approval.
  Until then, bind `inviterminal --toggle` in KDE (Phase 3).

## Reproduce

```bash
npm run check
```

```bash
INVI_AUTOTEST=library npm start
```
