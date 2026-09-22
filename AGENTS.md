# AGENTS.md

Instructions for coding agents working in this repository. The human-facing entry point is
[`README.md`](README.md); the design of record is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What this is

One artifact, not two: a **Cordis plugin** that is also a **profile bundle**. It is
mounted by `dsh plugin --profile <name> add dsh-zcode-scribe`, which forwards to pnpm in the
profile directory and then reconciles `dsh.profile.bundles` by detecting the
`dsh.bundle.patch` field in `package.json`.

| Piece | Path | Ships? |
| --- | --- | --- |
| Plugin entry + row | `index.js`, `cordis.patch.yml` | yes |
| Pure logic (no host imports, unit-testable) | `src/**` | yes |
| Suites | `test/**` | no (dev only) |
| Design of record | `docs/ARCHITECTURE.md` | repo only |
| Verification guards | `tools/**` | repo only |

## Commands

```sh
node test/run.mjs                     # every *.test.mjs, absolute paths, node:test
node test/run.mjs --help              # (there is no --help; run.mjs forwards nothing)
```

Against a **throwaway** `DSH_HOME` — never the one you are actually using. Point
`DSH_INSTALL` at whichever harness you are testing against; nothing here assumes a
particular install location:

```sh
export DSH_INSTALL="<dir containing node_modules/@deepseek-ai/dsh>"
export DSH_HOME=/tmp/dsh-scribe-dev
N="$DSH_INSTALL/node_modules/node/bin/node.exe"          # or wherever your node is
DSHBIN="$DSH_INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js"

"$N" "$DSHBIN" --profile web --from-default-profile web   # first use creates the profile
"$N" "$DSHBIN" plugin --profile web add "$PWD"            # install this checkout
"$N" "$DSHBIN" --profile web --dump-config | grep -A4 'id: scribe'
"$N" "$DSHBIN" --profile web --port 0 --no-open           # boot; --port 0 avoids collisions
```

`--port 0` matters: the default 3080 is frequently already held by another DSH instance,
and a boot that dies with `EADDRINUSE` looks nothing like the change you just made. `--no-open`
matters too — without it the boot opens a browser tab on the user's desktop.

### `--dump-config` is not a boot test, and `link:` installs need a junction

Two traps, both hit on 2026-09-21 and both invisible to each other's check.

**1. `--dump-config` only composes configuration; it does not apply plugins.** A row can
resolve perfectly — exit 0, stderr 0 bytes, correct `packageDir` and `version`, no duplicate
ids — and the profile still fail to boot, because a failure inside `apply()` or a duplicate
tool registration only happens when the tree is really applied. In this workspace that gap
cost a full profile outage: a plugin registering an already-taken tool name produced
`tool "git_status" is already registered`, the whole profile stopped booting, and
`--dump-config` was reporting a clean tree at the same moment. **Always do the `--port` boot
before claiming a plugin works.**

**2. `dsh plugin add <local-dir>` installs a `link:`, so the code stays in this repository
and bare imports resolve from *here*, not from the profile.** The profile's `node_modules`
is irrelevant to a linked package: Node walks up from `index.js`'s real path. Symptom:

```
failed to import loader entry scribe (dsh-scribe):
Cannot find package '@deepseek-ai/schemastery' imported from …\05-dsh-scribe\index.js
```

The repository therefore needs its own view of the host packages:

```powershell
# Windows: junction, not symlink — junctions do not need Administrator.
$parent = '<repo>\node_modules'
$link   = Join-Path $parent '@deepseek-ai'
New-Item -ItemType Directory -Path $parent -Force | Out-Null
New-Item -ItemType Junction -Path $link -Target "$DSH_INSTALL\node_modules\@deepseek-ai"
```

`node_modules/` is git-ignored, so this is a per-checkout setup step, not something a user of
the published package needs — a registry install gets its peers from the profile, where pnpm
puts them. Record it in your local notes; there is nothing to commit.

## What must not break

Ordered by how expensive the failure is.

1. **The writer must not be able to reach outside the memory room.** This is the entire
   reason the project exists. If the narrowing seam is unavailable in some profile, the
   answer is *do not extract* — never "fall back to the main agent doing the write with
   its full toolset". See `docs/ARCHITECTURE.md` §6.1.
2. **`narrowWriter: false` is a security downgrade, not a preference.** Any change that
   makes a safety property optional must name, in the config comment, which property it
   turns off and what remains exposed.
3. **An over-cap write must fail with a structured error, never truncate.** Silent
   truncation is how an agent comes to believe it saved something it did not. The
   *injected* copy may be truncated, but only with a visible warning line — stored text
   and loaded text are allowed to differ, and the model must be told when they do.
4. **`checkMemoryPath()` is the only gate on a write path.** Do not add a second caller
   that resolves paths itself, and do not "simplify" the four normalisations in
   `normalizeSensitiveSegment()`. Each one answers a documented attack; two of them
   (zero-width/bidi stripping, trailing-dot folding) are listed verbatim in the
   memory-poisoning literature.
5. **Row id `scribe` is global across every composed patch layer.** A collision is a hard
   boot failure, not an override. Repeat the `--dump-config | grep 'id: scribe'` check
   before any change to `cordis.patch.yml`.
   **The row's `name` is not a nickname — it is a module specifier, and it must equal
   `package.json`'s `name`.** The `id` may be short (`scribe`); the `name` may not. It is
   resolved from the *profile* directory while the tree is applied, so a stale value
   produces a plugin that installs, passes every unit test and passes `--dump-config`,
   then fails to boot. That is what 1.0.0 shipped (`cordis.patch.yml` kept `dsh-scribe`
   after the package became `dsh-zcode-scribe`). `tools/boot-check.mjs` asserts it.
   A rename touches four places: `package.json` `name`, the repository name, this row's
   `name`, and the local directory name.
6. **`src/**` stays host-free.** No `@deepseek-ai/*` import and no `node:fs` under `src/`.
   That is what makes the safety logic testable as a table of strings instead of through a
   live harness, and it is why the suite runs in under a second.
7. **The README's status banner stays honest, in both directions.** It must keep naming
   what does *not* exist yet — writes, extraction and the narrowed writer, all gated on
   M0 — and must not widen the claim before M0 has run. It must equally not understate
   what does work: the read half boots, and a real model session on the WSL line used
   `scribe_recall` to answer from a memory room.
8. **Never commit a throwaway `DSH_HOME`, a memory room, or a session transcript.** See
   `.gitignore`.
9. **"Installed" means a real `--port` boot with empty stderr, not a clean `--dump-config`.**
   See the two traps above. Every claim in `README.md` about what works must be traceable to
   either a `node test/run.mjs` assertion or a recorded boot, and the boot's raw output
   belongs in `docs/MEASUREMENTS.md`. `tools/boot-check.mjs` is that boot, in CI.
10. **`test/run.mjs` pins `--test-reporter=tap`.** Node 24 changed the default reporter for
    a non-TTY stdout from `tap` to `spec`, which changes `# pass 101` into `ℹ pass 101` and
    leaves `tools/verify-doc-numbers.mjs` unable to read the live summary on one machine and
    fine on another. Do not unpin it, and do not write a new consumer that parses whatever
    the environment emits.

## The M0 gate

**No feature work lands before this probe passes.**

M0 is a throwaway script that mints a child agent, attaches
`childCtx.tools.restrict({ deny: ['bash'] })`, and prints the child's visible tool names.
It exists because the load-bearing assumption of this whole design — that a subagent's
capability set can be narrowed through a public seam — has been **read in the harness
source but never executed**.

| Probe result | Consequence |
| --- | --- |
| `bash` absent from the child's visible set, no throw | proceed to M1-onwards as designed |
| `restrict()` throws for the child context | try attaching from a `ctx.on('agent/created')` listener against the child's `agent.ctx` |
| neither works | the design changes, or the project stops. Report the finding; do not paper over it. |

Record the probe's raw output in `docs/MEASUREMENTS.md`.

## Repository conventions

Modelled on [`BOWLUNA/dsh-custom-mode`](https://github.com/BOWLUNA/dsh-custom-mode):

- **Bilingual doc pairs** — every user-facing document exists as `X.md` (English) and
  `X.zh.md` (Chinese), with `X.i18n.yaml` recording the git blob hash of each side at the
  last confirmed-consistent revision. Change one side, change the other, re-record, in that
  order: numbers first, then re-record the hashes, then re-run the number guard. The
  verifier is `tools/verify-translation-pairing.mjs` and it runs in CI.
- **Documents declared English-only** carry no pair, and the verifier prints each one with its
  reason on every run — `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/MEASUREMENTS.md`,
  `docs/PUBLISHING.md`, `docs/TROUBLESHOOTING.md`. That list is the honest statement of the
  gap, not an assumption: adding a document means deciding which list it belongs in.
- **Invariants over instructions.** A rule that matters gets a test, not a paragraph. This
  file's "what must not break" list is the *index* into those tests, and
  `tools/boot-check.mjs` is the one that applies the plugin to a real harness.
- **A guard is not finished until a mutation has made it fail.** See
  `docs/TROUBLESHOOTING.md` § "A guard that passes while testing nothing" — this repository
  shipped one that did exactly that.

## Working in the shared workspace

This checkout lives inside a workspace where several agent windows run concurrently
(`C:\BL\Work\WorkSpace\WorkBuddy\ZCode`). The binding contract is
`.codebuddy/rules/00-协作铁律-多窗口防冲突.md` — **read it before touching anything
outside this directory.** The parts that most often matter here:

- **This repository is ours alone.** `05-dsh-scribe/**` belongs to the `05` window. Do not
  write into other windows' directories, and do not let another window write here.
- **Never install into a shared profile.** If you point at a harness other people
  on this machine also use — a desktop install, say — its `DSH_HOME` is shared, and
  concurrent pnpm runs there have already emptied `node_modules` once. Use a
  throwaway `DSH_HOME` (`tools/boot-check.mjs` makes one for you), or better, stand
  up your own harness under `$DSH_INSTALL` and test against that.
- **The harness is found, never assumed, and never hardcoded.** A previous install
  root was relocated on 2026-09-21 and the old trees were deleted; every literal in
  this repository went stale at once, including the rescue message in `install.sh`.
  So resolve it in this order, first hit wins:

  | # | Where | Who relies on it |
  | --- | --- | --- |
  | 1 | `--dsh-bin <path>` | explicit, highest priority |
  | 2 | `$DSH_INSTALL` | the supported way to point at a harness somewhere unexpected |
  | 3 | `<repo>/node_modules/@deepseek-ai/dsh` | CI's `npm install --no-save` |
  | 4 | `dsh` on PATH | a machine-level install |

  None of the four ⇒ exit 2 with the exports to copy, never a silent skip.
  `tools/boot-check.mjs` and `tools/resolve-dsh.sh` implement exactly this, and a
  test asserts they have not grown a literal back. **Do not add one.**
- **Ports** for this project: **31850–31859** for the shared-harness era, and
  **32050–32059** for a standalone `$DSH_INSTALL` lab instance. `3080` and `3099`
  are held by long-running WSL DSH instances and are never ours to bind.
  `--port 0` sidesteps the whole question.
- **Shared files are append-only**: `.workbuddy/memory/MEMORY.md`, `.workbuddy/memory/*.md`,
  and the registry table inside the collaboration rules.
