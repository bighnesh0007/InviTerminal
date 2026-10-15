#!/bin/sh
# One command for machines without MongoDB / whisper.cpp: starts MongoDB in Docker (localhost only)
# and downloads the speech model(s) into the app's model folder. Safe to re-run.
#
#   ./scripts/docker-setup.sh            MongoDB + speech model
#   ./scripts/docker-setup.sh --tdrz     …plus the optional speaker-turn model (~465 MB)
#   ./scripts/docker-setup.sh --no-mongo just the models (you already have MongoDB)
set -eu
cd "$(dirname "$0")/.."

tdrz=0 mongo=1
for a in "$@"; do
  case "$a" in
    --tdrz) tdrz=1 ;;
    --no-mongo) mongo=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose …)." >&2; exit 1; }

models="${INVI_MODELS_DIR:-$HOME/.config/inviterminal/models}"
# Create it as YOU first — if Docker created it, it would be owned by root and the app couldn't write there.
mkdir -p "$models"

if [ "$mongo" = 1 ]; then
  port="${INVI_MONGO_PORT:-27017}"
  if command -v ss >/dev/null && ss -ltn "sport = :$port" | grep -q LISTEN && ! docker compose ps --status running mongo 2>/dev/null | grep -q mongo; then
    echo "Port $port is already in use (another MongoDB?). Re-run with INVI_MONGO_PORT=27018, or --no-mongo to use yours." >&2
    exit 1
  fi
  echo "Starting MongoDB (127.0.0.1:$port)…"
  docker compose up -d --wait mongo
fi

echo "Downloading speech model(s) into $models…"
INVI_UID="$(id -u)" INVI_GID="$(id -g)" INVI_TDRZ="$tdrz" INVI_MODELS_DIR="$models" docker compose run --rm models

if ! command -v whisper-cli >/dev/null; then
  echo "Fetching the whisper.cpp image (whisper-cli isn't installed on this machine)…"
  docker compose --profile tools pull whisper
fi

echo
echo "Done. In InviTerminal → Settings:"
[ "$mongo" = 1 ] && echo "  • Library → MongoDB URI: mongodb://127.0.0.1:${INVI_MONGO_PORT:-27017}/inviterminal  (the default if the port is 27017)"
command -v whisper-cli >/dev/null || echo "  • Speech-to-text → whisper binary: $(pwd)/docker/whisper-cli"
echo "Optional extras still installed on the host: espeak-ng (read questions aloud), pipewire-pulse (Live transcript)."
