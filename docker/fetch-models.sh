#!/bin/sh
# Downloads InviTerminal's whisper models into /models (the host's app model folder).
# Skips files that are already complete; downloads to .part first so a failed download never
# leaves a truncated model the app would try to load.
set -eu

fetch() { # name url expected-bytes
  name=$1 url=$2 size=$3
  dest="/models/$name"
  if [ -f "$dest" ] && [ "$(wc -c < "$dest")" -eq "$size" ]; then
    echo "✓ $name already present"
    return
  fi
  echo "↓ $name ($((size / 1000000)) MB)…"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$url"
  got=$(wc -c < "$dest.part")
  if [ "$got" -ne "$size" ]; then
    echo "✗ $name: got $got bytes, expected $size — not installed" >&2
    rm -f "$dest.part"
    exit 1
  fi
  mv "$dest.part" "$dest"
  echo "✓ $name"
}

# Speech-to-text (required for Mic, Practice and Live transcript).
fetch ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin 147964211

# Speaker turns (optional; only the "Turns" speaker mode uses it). Note the different repo.
if [ "${INVI_TDRZ:-0}" = "1" ]; then
  fetch ggml-small.en-tdrz.bin https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin 487614184
fi
echo "Models are in the app's model folder."
