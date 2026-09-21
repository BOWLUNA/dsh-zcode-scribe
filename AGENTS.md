# AGENTS.md

Instructions for coding agents working in this repository. The human-facing entry point is
[`README.md`](README.md); the design of record is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What this is

One artifact, not two: a **Cordis plugin** that is also a **profile bundle**. It is
mounted by `dsh plugin --profile <name> add dsh-scribe`, which forwards to pnpm in the
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

Against a **throwaway** harness — never the DSH_HOME you are actually using:

```sh
export DSH_HOME=/tmp/dsh-scribe-dev
NODE="C:/BL/AI/DSH Desktop/resources/app/node_modules/node/bin/node.exe"
DSHBIN="C:/BL/AI/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js"

"$NODE" "$DSHBIN" --profile web --from-default-profile web   # first use creates the profile
"$NODE" "$DSHBIN" plugin --profile web add "$PWD"            # install this checkout
"$NODE" "$DSHBIN" --profile web --dump-config | grep -A4 'id: scribe'
"$NODE" "$DSHBIN" --profile web --port 0 --no-open           # boot; --port 0 avoids collisions
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
New-Item -ItemType Junction -Path $link -Target 'C:\BL\AI\DSH Desktop\resources\app\node_modules\@deepseek-ai'
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
6. **`src/**` stays host-free.** No `@deepseek-ai/*` import and no `node:fs` under `src/`.
   That is what makes the safety logic testable as a table of strings instead of through a
   live harness, and it is why the suite runs in under a second.
7. **The README's status banner stays honest.** It currently says "not installable yet".
   Do not soften it until M0 has actually run.
8. **Never commit a throwaway `DSH_HOME`, a memory room, or a session transcript.** See
   `.gitignore`.
9. **"Installed" means a real `--port` boot with empty stderr, not a clean `--dump-config`.**
   See the two traps above. Every claim in `README.md` about what works must be traceable to
   either a `node test/run.mjs` assertion or a recorded boot, and the boot's raw output belongs
   in `docs/MEASUREMENTS.md` once that file exists.

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

Record the probe's raw output in `docs/MEASUREMENTS.md` when that file exists.

## Repository conventions

Modelled on [`BOWLUNA/dsh-custom-mode`](https://github.com/BOWLUNA/dsh-custom-mode):

- **Bilingual doc pairs** — every user-facing document exists as `X.md` (English) and
  `X.zh.md` (Chinese), with `X.i18n.yaml` recording the git blob hash of each side at the
  last confirmed-consistent revision. Change one side, change the other, re-record.
  **Status: the pairing manifest and its verifier (`tools/verify-translation-pairing.mjs`)
  do not exist yet.** `README.md` / `README.zh.md` are the first pair; the manifest lands
  with the tooling in M6. Until then, treat a pair as unverified by definition.
- **Invariants over instructions.** A rule that matters gets a test, not a paragraph. This
  file's "what must not break" list is the *index* into those tests.
- **Bilingual commit-visible artefacts**: `docs/ARCHITECTURE.md` is English-only today for the
  same reason — its pair arrives with the manifest.

## Working in the shared workspace

This checkout lives inside a workspace where several agent windows run concurrently
(`C:\BL\Work\WorkSpace\WorkBuddy\ZCode`). The binding contract is
`.codebuddy/rules/00-协作铁律-多窗口防冲突.md` — **read it before touching anything
outside this directory.** The parts that most often matter here:

- **This repository is ours alone.** `05-dsh-scribe/**` belongs to the `05` window. Do not
  write into other windows' directories, and do not let another window write here.
- **Never install into the shared `%APPDATA%\dsh-desktop\harness\profiles\web`.** Other
  windows are using it; concurrent pnpm runs there have already emptied `node_modules`
  once. Use a throwaway `DSH_HOME` instead.
- **Ports** for this project: **31850–31859**. `3080` and `3099` are held by long-running
  WSL DSH instances and are never ours to bind. `--port 0` sidesteps the whole question.
- **Shared files are append-only**: `.workbuddy/memory/MEMORY.md`, `.workbuddy/memory/*.md`,
  and the registry table inside the collaboration rules.
