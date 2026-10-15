---
type: decision-record
status: Files written and statically checked; NOT run end to end (images were not pulled, by the user's choice). Verify with the checklist below before relying on it.
verified-on: 2026-10-16
---

# Docker — dependencies in containers, the app on the desktop

## Decision (user's pick, 2026-10-16)

**Dependencies in Docker + a build container.** The app itself is **not** containerised:
its core features act on the user's desktop session — asking KWin to keep its window out of
screen captures (session D-Bus), recording the speakers/mic (PipeWire), and opening the user's
own shell and files (node-pty). A container exists to cut those off; passing the host's Wayland,
D-Bus and PipeWire sockets in would make a fragile app whose terminal is a shell *inside* the
container. Rejected for that reason.

## What's provided

| File | What it does |
|---|---|
| `compose.yaml` | **mongo** — MongoDB 8 for the snippet library, bound to **127.0.0.1 only** (never the LAN), data in a named volume, healthcheck. Port `INVI_MONGO_PORT` (default 27017). **models** (profile `setup`) — one-shot download of `ggml-base.en.bin` (+ the tdrz model with `INVI_TDRZ=1`) into the app's model folder, size-checked, via `.part` files. **whisper** (profile `tools`) — the official `ghcr.io/ggml-org/whisper.cpp:main` image, listed so `compose pull` fetches it. |
| `docker/whisper-cli` | Drop-in for a host `whisper-cli`: runs the CLI in that image with `--network none`, as the user, mounting only the folders of the files it's given (model read-only, temp audio/output read-write). Point **Settings → Speech-to-text → whisper binary** (or `INVI_WHISPER_BIN`) at it. |
| `docker/fetch-models.sh` | The download logic the models job runs. |
| `scripts/docker-setup.sh` | One command: creates the model folder as the user (so Docker doesn't create it root-owned), starts Mongo (refuses if the port is taken by a non-Compose MongoDB), downloads models, pulls the whisper image if whisper-cli isn't installed, prints the Settings to use. Flags: `--tdrz`, `--no-mongo`. |
| `docker/build.Dockerfile` | Builds the AppImage + unpacked dir with no Node/Python/g++ on the host: `docker build -f docker/build.Dockerfile --target out -o release .` Runs typecheck + tests first. |
| `.dockerignore` | Keeps `.env` (the Groq key), `node_modules`, build output and `.git` out of the build context. |

Still needed on the host (they act on the desktop session, so they can't be containerised usefully):
PipeWire/`parecord` (Live transcript), `espeak-ng` (optional read-aloud), KDE Plasma 6.6+ on Wayland
(capture exclusion).

`test/library-store.test.ts` now skips — visibly — when there's no `/usr/bin/mongod` (the build
image), and still runs on a dev machine that has one.

## Verified vs not

- **Verified:** `docker compose config` accepts the file (services mongo/models/whisper); all three
  scripts pass `sh -n`; `docker/whisper-cli` run against a fake `docker` builds the intended command
  (mounts deduplicated, model `:ro`, temp `:rw`, `--network none`, `--user`, image before the args);
  the full test suite still passes on the host.
- **Not verified (no images were pulled):** that the whisper.cpp image has `whisper-cli` on its PATH
  and accepts `--user`; Mongo starting/healthcheck; the models job; the build container producing an
  AppImage (incl. node-pty compiling and Electron downloading inside it); whisper-in-Docker latency
  (expect +0.3–1 s per transcription for container start).

### Checklist to verify (≈1.4 GB of images)

```bash
INVI_MONGO_PORT=27027 ./scripts/docker-setup.sh
```

```bash
docker compose ps
```

Transcribe any short speech WAV through the container (expect the words back):

```bash
./docker/whisper-cli -m ~/.config/inviterminal/models/ggml-base.en.bin -f /path/to/speech.wav -nt -np
```

```bash
docker build -f docker/build.Dockerfile --target out -o release .
```

```bash
docker compose down
```
