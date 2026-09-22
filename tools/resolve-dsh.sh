#!/usr/bin/env sh
# Resolving the `dsh` CLI, shared by `install.sh` and `uninstall.sh`.
#
# Sourced, not executed. Defines `resolve_dsh` (sets `DSH`) and `run_dsh`.
#
# Why this file exists at all: both entry points used to carry their own
# hardcoded fallback path, and both went stale at once on 2026-09-21 when the
# desktop harness moved from `C:\BL\AI\DSH Desktop` to `C:/BL/AI/dsh-harness`.
# The rescue message in `install.sh` — the only guidance a user sees when the
# install fails — was pointing at two directories that no longer existed. One
# source of truth is the fix; a second copy would drift again.
#
# Resolution order, first hit wins. This is the same order as
# `tools/boot-check.mjs`, which is the reference implementation:
#
#   1. `dsh` on PATH                       a machine-level install
#   2. `$DSH_INSTALL`                      the supported way to point at a
#                                          harness somewhere unexpected
#   3. `C:/BL/AI/dsh-harness`              a literal, and therefore a
#                                          convenience rather than a promise
#
# `$DSH_INSTALL` is the harness **install root**: the directory whose
# `node_modules/@deepseek-ai/dsh` is the CLI.

# Sets DSH to a runnable command, or prints what to do and exits 1.
resolve_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    DSH=dsh
    return 0
  fi

  for root in "${DSH_INSTALL:-}" "C:/BL/AI/dsh-harness"; do
    [ -n "$root" ] || continue

    entry="$root/node_modules/@deepseek-ai/dsh/lib/bin.js"
    [ -f "$entry" ] || continue

    node=""
    for candidate in "$root/node_modules/node/bin/node.exe" "$root/node_modules/node/bin/node"; do
      if [ -x "$candidate" ]; then
        node="$candidate"
        break
      fi
    done
    if [ -z "$node" ] && command -v node >/dev/null 2>&1; then
      node=node
    fi
    [ -n "$node" ] || continue

    DSH="$node $entry"
    return 0
  done

  cat >&2 <<'MSG'
dsh is not on PATH, and no harness was found through $DSH_INSTALL or the
current default location. Point at one explicitly and re-run:

  export DSH_INSTALL="C:/BL/AI/dsh-harness"     # the harness install root
  ./install.sh

See docs/TROUBLESHOOTING.md for the full recipe.
MSG
  exit 1
}

# DSH may be "node /path/to/bin.js", so the expansion is deliberately unquoted.
# shellcheck disable=SC2086
run_dsh() { $DSH "$@"; }
