#!/bin/sh
# Runs InviTerminal on Arch's Electron 44 (the tested major; bump deliberately).
# Electron flags from ~/.config/electron44-flags.conf are honoured by Arch's electron44 launcher.
exec /usr/bin/electron44 /usr/lib/inviterminal/app.asar "$@"
