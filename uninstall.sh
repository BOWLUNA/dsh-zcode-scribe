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

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh is not on PATH — see docs/TROUBLESHOOTING.md for how to reach it on DSH Desktop." >&2
  exit 1
fi

echo "removing dsh-zcode-scribe from profile '$PROFILE'"
dsh plugin --profile "$PROFILE" remove dsh-zcode-scribe

echo
echo "remaining scribe rows (expect none):"
if dsh --profile "$PROFILE" --dump-config | grep -q '^- id: scribe'; then
  echo "  still present — the row is declared somewhere other than the dependency (check cordis.patch.yml)" >&2
  exit 1
fi
echo "  none"
echo
echo "memory rooms were left untouched."
