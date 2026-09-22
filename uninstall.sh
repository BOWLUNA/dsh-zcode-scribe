#!/usr/bin/env sh
# Remove dsh-zcode-scribe from a harness profile.
#
#   ./uninstall.sh
#   DSH_PROFILE=tui ./uninstall.sh
#
# Your memories are NOT deleted. The memory room is a directory of markdown files
# in each workspace (`.dsh/memory` by default), and this script never touches it:
# reinstalling finds everything where you left it. Delete the room by hand if that
# is what you want.
set -eu

PROFILE="${DSH_PROFILE:-web}"

# Same resolver as install.sh, for the same reason: the fallback path in this
# script used to name `%APPDATA%\dsh-desktop\harness`, which stopped existing on
# 2026-09-21. See tools/resolve-dsh.sh.
. "$(cd "$(dirname "$0")" && pwd)/tools/resolve-dsh.sh"
resolve_dsh

echo "removing dsh-zcode-scribe from profile '$PROFILE'"
run_dsh plugin --profile "$PROFILE" remove dsh-zcode-scribe

echo
echo "remaining scribe rows (expect none):"
if run_dsh --profile "$PROFILE" --dump-config | grep -q '^- id: scribe'; then
  echo "  still present — the row is declared somewhere other than the dependency (check cordis.patch.yml)" >&2
  exit 1
fi
echo "  none"
echo
echo "memory rooms were left untouched."
