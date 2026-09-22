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

# Where does `dsh` come from? See tools/resolve-dsh.sh — one resolver, shared with
# uninstall.sh, resolving in the order PATH → $DSH_INSTALL → a literal. The literal
# is a convenience, not a promise: a second hardcoded copy is what went stale on
# 2026-09-21 when the desktop harness moved.
. "$(cd "$(dirname "$0")" && pwd)/tools/resolve-dsh.sh"
resolve_dsh

echo "installing $SPEC into profile '$PROFILE'"
run_dsh plugin --profile "$PROFILE" add "$SPEC"

# Confirming the row is present is not the same as confirming the profile boots.
# A row can resolve in --dump-config and still fail at apply() time, so the
# message says what was actually checked rather than implying more. For the
# check that does apply the plugin, run `node tools/boot-check.mjs`.
echo
echo "row check (this proves the row composes, not that the profile boots):"
run_dsh --profile "$PROFILE" --dump-config | grep -A3 '^- id: scribe' || {
  echo "the scribe row is missing from the composed tree — inspect the output above" >&2
  exit 1
}
echo
echo "done. Restart the harness to apply a new bundle row."
