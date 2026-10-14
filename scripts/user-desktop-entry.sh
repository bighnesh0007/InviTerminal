#!/usr/bin/env bash
# Installs or removes a per-user desktop entry + icons for InviTerminal (no root, nothing outside
# $XDG_DATA_HOME). Needed for the portal global shortcut: xdg-desktop-portal identifies an
# unsandboxed app by an installed inviterminal.desktop. The Arch package installs its own system
# entry; use this only for the AppImage or a dev checkout.
#
#   scripts/user-desktop-entry.sh install [--exec '<command>'] [--force]
#   scripts/user-desktop-entry.sh uninstall
#
# Default command: this checkout's AppImage (with APPIMAGE_EXTRACT_AND_RUN=1 when libfuse.so.2 is
# absent). Only files carrying the X-InviTerminal-UserEntry marker are ever overwritten or removed.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop="$data/applications/inviterminal.desktop"
marker='X-InviTerminal-UserEntry=true'
sizes=(16 32 48 64 128 256 512)

ours() { [[ -f "$1" ]] && grep -qx "$marker" "$1"; }

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" || true
  # KDE's menu cache lives in ~/.cache, keyed by data dirs; only rebuild it for the real data dir,
  # so a test run with another XDG_DATA_HOME leaves no cache files behind.
  if [[ "$data" == "$HOME/.local/share" ]] && command -v kbuildsycoca6 >/dev/null; then kbuildsycoca6 >/dev/null 2>&1 || true; fi
}

cmd="${1:-}"; shift || true
exec_cmd=""; force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --exec) exec_cmd="$2"; shift 2 ;;
    --force) force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$cmd" in
  install)
    if [[ -e "$desktop" ]] && ! ours "$desktop" && [[ $force -ne 1 ]]; then
      echo "Refusing: $desktop exists and was not created by this script (use --force to replace it)." >&2
      exit 1
    fi
    if [[ -z "$exec_cmd" ]]; then
      appimage="$(ls "$root"/release/InviTerminal-*-x86_64.AppImage 2>/dev/null | head -1)"
      [[ -n "$appimage" ]] || { echo "No AppImage in $root/release; build it (npm run dist:linux) or pass --exec." >&2; exit 1; }
      if ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then exec_cmd="$appimage"; else exec_cmd="env APPIMAGE_EXTRACT_AND_RUN=1 $appimage"; fi
    fi
    mkdir -p "$data/applications"
    sed -e "s|^Exec=inviterminal --toggle$|Exec=$exec_cmd --toggle|" -e "s|^Exec=inviterminal$|Exec=$exec_cmd|" \
      "$root/packaging/arch/inviterminal.desktop" > "$desktop.tmp"
    printf '%s\n' "$marker" >> "$desktop.tmp"
    mv "$desktop.tmp" "$desktop"
    for s in "${sizes[@]}"; do install -Dm644 "$root/build/icons/${s}x${s}.png" "$data/icons/hicolor/${s}x${s}/apps/inviterminal.png"; done
    refresh
    echo "Installed $desktop"
    echo "  Exec=$exec_cmd"
    ;;
  uninstall)
    if ours "$desktop"; then rm -f "$desktop"; echo "Removed $desktop"; else echo "No entry created by this script at $desktop; nothing removed."; fi
    for s in "${sizes[@]}"; do rm -f "$data/icons/hicolor/${s}x${s}/apps/inviterminal.png"; done
    refresh
    ;;
  *) echo "usage: $0 install [--exec '<command>'] [--force] | uninstall" >&2; exit 2 ;;
esac
