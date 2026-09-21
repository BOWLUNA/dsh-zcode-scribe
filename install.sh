#!/usr/bin/env sh
# Install dsh-zcode-scribe into a harness profile.
#
#   ./install.sh                      # this checkout, into the `web` profile
#   ./install.sh dsh-zcode-scribe     # the published package, from npm
#   DSH_PROFILE=tui ./install.sh      # a different profile
#
# The plugin ships no runtime dependencies, so this is the whole installation:
# one row into the profile's bundle list, which `dsh plugin add` reconciles for
# you. Nothing is written outside the profile and the memory room the agent later
# creates for itself.
set -eu

PROFILE="${DSH_PROFILE:-web}"
SPEC="${1:-}"

if [ -z "$SPEC" ]; then
  # Default to this checkout, resolved absolutely: a relative spec is resolved
  # against the profile directory by `dsh plugin`, which is never what is meant.
  SPEC="$(cd "$(dirname "$0")" && pwd)"
fi

if ! command -v dsh >/dev/null 2>&1; then
  cat >&2 <<'MSG'
dsh is not on PATH. On DSH Desktop the CLI exists but is not exposed globally;
call it through the app's bundled Node instead:

  DSH_HOME="$APPDATA/dsh-desktop/harness" \
  "$APPDATA/../Local/Programs/DSH Desktop/resources/app/node_modules/node/bin/node.exe" \
  "$APPDATA/dsh-desktop/../DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add <spec>

Exact paths differ per installation; see docs/TROUBLESHOOTING.md.
MSG
  exit 1
fi

echo "installing $SPEC into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$SPEC"

# Confirming the row is present is not the same as confirming the profile boots.
# A row can resolve in --dump-config and still fail at apply() time, so the
# message says what was actually checked rather than implying more.
echo
echo "row check (this proves the row composes, not that the profile boots):"
dsh --profile "$PROFILE" --dump-config | grep -A3 '^- id: scribe' || {
  echo "the scribe row is missing from the composed tree — inspect the output above" >&2
  exit 1
}
echo
echo "done. Restart the harness to apply a new bundle row."
