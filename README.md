# dsh-zcode-scribe

[![test](https://github.com/BOWLUNA/dsh-zcode-scribe/actions/workflows/test.yml/badge.svg)](https://github.com/BOWLUNA/dsh-zcode-scribe/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-7d8a6a.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.2%20%7C%7C%20%3E%3D0.1.6--alpha.1-7d8a6a.svg)](#compatibility)
[![node](https://img.shields.io/badge/node-%3E%3D20-7d8a6a.svg)](#compatibility)

`v1.0.0` · developed and verified against dsh `>=0.1.5-rc.2 <0.2.0 || >=0.1.6-alpha.1 <0.2.0`.

**Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) whose writer is a narrowed subagent.**

```bash
dsh plugin --profile web add dsh-zcode-scribe
```

![The four assertions a boot check makes, and the one that actually catches a broken plugin](docs/assets/boot-check.svg)

> **Status: early, and read-only.** The `scribe_recall` tool is registered, executes for real
> inside a live host, and a real model session on dsh `0.1.6-alpha.2` used it to answer from a
> memory room — [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) carries the raw output behind
> every claim below. 104 tests pass. What does **not** exist yet: writes, extraction, and the
> narrowed writer, which is gated on milestone **M0** — proving a subagent's capability set can
> actually be narrowed through a public seam. Nothing is injected into the prompt yet, so
> installing this changes what the model can *ask for*, not what it knows.

[简体中文](README.zh.md)

---

## What it takes from ZCode, and where it goes further

[ZCode](https://github.com/zai-org/ZCode) (`zai-org/ZCode`, together with
[`zai-org/GLM-skills`](https://github.com/zai-org/GLM-skills)) is where this project's memory
model comes from: an extraction subagent, a manifest of one-line topic descriptions, and a
memory room of plain markdown. That lineage is a credit, not a dependency — nothing here needs
a ZCode install, a GLM key, or any vendor credential; model capability goes through the host's
own `ctx.llm`.

| What ZCode has | What this takes from it | Where this goes further | Evidence (a command or a test name) |
| --- | --- | --- | --- |
| `core/src/memory/extraction.ts:42` `buildMemoryExtractionPrompt` | The extraction-subagent prompt: analyse the last N messages, prefer updating an existing file over creating a duplicate, output `Nothing to save.` when there is nothing | The prompt is built by this plugin rather than borrowed wholesale, and it names memory *types* and a frontmatter format the room itself defines | **Not yet proven** — the extraction half is not written; the gate is `issues/M0-1` |
| `extraction.ts:68` `evaluateMemoryExtraction` — skip on `direct-memory-write` | The skip-condition idea: if the agent already wrote to the room this turn, do not extract on top of it | The containment test it needs is this plugin's own `src/paths.mjs` — a pure function with 52 table cases, not a helper that has to trust its inputs | `node test/run.mjs` › `test/paths.test.mjs` (52 cases, e.g. `truncates at the first colon so an NTFS stream cannot hide a reserved name`) |
| `extraction.ts:78` — skip on `no-user-prose`, with `MINIMUM_USER_WORDS = 3` (`extraction.ts:6`) | The threshold, and that it counts *user* prose rather than any message | The same number is a config key (`minUserWords`), so it is tunable per profile instead of a module constant | `index.js:124` (`minUserWords: z.number().default(3)`) · `node test/run.mjs` › `test/apply.test.mjs` › `narrows the writer, refuses secrets, and caps the index` |
| `extraction.ts:228` `containsDirectMemoryWrite` | Deciding "was this a memory write" by resolving the tool's path against the room | No ZCode counterpart: `checkMemoryPath()` refuses traversal, Unicode smuggling and NTFS alternate data streams **before** the comparison, and it is the only gate on the write path | `node test/run.mjs` › `test/paths.test.mjs` › `strips bidirectional overrides, which render a name as its reverse` and `truncates at the first colon so an NTFS stream cannot hide a reserved name` |
| `core/src/subagent/profile.ts:78` — subagent `tools:` allowlists | Narrowing a subagent by naming the tools it may use | **ZCode keeps the parent's full tool catalogue in the extraction subagent's provider request and narrows only at the tool-use boundary** — its own note says so at `core/src/memory/memory-agent-loop.ts:70`. The design here removes the tools from the scope the model sees (`ctx.tools.restrict`), so there is nothing to call, rather than a call to refuse | **Not yet proven** — `plugins/memory/dsh-zcode-scribe/lab/05-m0-probe.mjs` was executed and reached no agent ctx on a session-less boot. See `issues/M0-1` |
| `tool/executor/memory-file-permission.ts:22` — grants `Write`/`Edit` on memory `.md` | The notion of a permission rule scoped to the memory directory | That rule *allows*; this plugin's writer is designed to have no other capability to allow | `node test/run.mjs` › `test/apply.test.mjs` › `narrows the writer, refuses secrets, and caps the index` — proves the key and its default; **the narrowing itself: Not yet proven** |

**Where this does not (yet) beat ZCode:** ZCode has a working extraction path today and this
does not. This ships the read half and refuses to extract until M0 clears. That is the honest
state, and it is why the table has a "not yet proven" row rather than a claim — a table with no
such row would be marketing.

### Reproducing the comparison

Every row above is meant to be checkable from a clean clone. These are the commands, and they
were run before this paragraph was written:

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-scribe && cd dsh-zcode-scribe
npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2   # the peer packages
npm install -g pnpm@12                     # `dsh plugin add` forwards to pnpm; dsh does not bundle it
node test/run.mjs                          # 104 checks
node tools/boot-check.mjs --port 32050     # boots the plugin; finds the harness in ./node_modules
```

**The peer install is not optional, and that is measured rather than assumed.** Skipping it makes
the suites that import `index.js` fail to resolve `@deepseek-ai/*`, and the run reports a
partial summary — `57 / 8 / 55 / 2` against `104 / 16 / 104 / 0` for tests, suites, passing and
failing — which is a clean-looking run that says nothing about the plugin. Measured in a fresh clone with and without the step.

The ZCode half of the table is read from a [ZCode](https://github.com/zai-org/ZCode) checkout,
one named file and line at a time. Nothing here needs a model, a credential or a network call —
if a row cannot be checked that way, it says **Not yet proven** instead.

### The M0 gate, stated as a testable question

**Can a subagent's capability set be narrowed through a public DSH seam?** If yes, extraction
ships on top of it. If no, extraction does **not** ship — the fallback is not "let the main
agent write memory with its full toolset". [`issues/M0-1`](issues/) carries what has been
executed so far and what failed, with raw output.

## The problem this is actually solving

The DSH plugin market lists **190 plugins under `memory`**. Long-term memory is not an
empty niche, and this project is not justified by a missing *feature*. It is justified by
three missing **safety properties**, and it only takes the second slot in the table below
because the first is already served by other people's work.

| Property | Existing coverage |
| --- | --- |
| A local, bounded, inspectable store | **Covered.** `engramory`, `dsh-memento`, `dsh-memoir` and dozens more do this well. Install one of those. |
| **Hard permission narrowing for the component that decides what to remember** | **None.** No plugin removes capabilities from its writer; the closest analog, `dsh-memento`, gates writes behind human approval — a different and complementary mechanism. |
| **Path safety on the write path** (root-relative denylist, Unicode bidi/control stripping, NTFS alternate-data-stream truncation, containment) | **None.** Schemes that store in a database avoid it; every markdown-based option leaves it open. |

This matters more every month. **OWASP ASI06 — Memory & Context Poisoning** joined the
Agentic Top 10 for 2026, and the published numbers are not close:

- **98%** injection success for a memory-poisoning payload (GhostWriter), **~60%**
  activation even with polite phrasing, and **0% detection** by existing one-turn
  injection filters.
- **95%+** (MINJA), **80%+ at under 0.1% poison rate** (AgentPoison).

Anthropic's own memory-tool documentation says restricting operations to the memory
directory *"is not optional for any agent with write access to persistent storage"*, and
advises scoping write permission to the sessions that actually add memories.

What makes the problem unavoidable is this: **legitimate memory writing and malicious
memory injection are the same operation.** Same file, same write call — only intent
differs, and intent is not observable.

So `dsh-zcode-scribe` does not try to detect intent. It removes capability, and constrains what
remains:

```
the writer  →  cannot see:   shell · run_code · every MCP tool · network fetch/search
                            subagents · present · upload/attachment tools
             →  can do:      Read/Grep/Glob · Write/Edit only inside the memory room
                            rm only for a contained, absolute, non-glob, non-recursive .md
```

Two enforcement layers, because they fail differently:

| Layer | Seam | Effect |
| --- | --- | --- |
| **Remove** | `ctx.tools.restrict({ deny })` on the writer's `agent.ctx` | the tool is absent from the writer's tool list — it cannot be talked into reaching for it |
| **Constrain** | `ctx.tools.guard(exec => reason \| undefined)` on the writer's `agent.ctx` | argument-level policy for the tools that must remain, e.g. "read a file, but write only `*.md` under the memory root" |

Both require a *scoped* context and both throw rather than silently degrade to global —
which is what makes them usable as a security boundary instead of a convention.

## What is borrowed

Almost everything. This project's contribution is the combination, not the parts:

- **Claude Code** — *memory is an index, not storage*; `MEMORY.md` capped at the first
  200 lines or 25 KB; topic files loaded on demand, never at session start; **an
  over-cap write succeeds and returns an error telling the model to rewrite the index**
  rather than truncating silently; subagent memory in a separate directory.
- **Anthropic memory tool** — client-side storage ownership, `/memories` as a mapped
  prefix, mandatory path-traversal rejection.
- **Anthropic managed memory stores** — immutable version per change (audit + rollback),
  a hard capacity cap where **writes fail loudly**, and scoping write access.
- **Memory-poisoning research** (AM-Sentry, memory-risk scoring) — an admission policy
  before storage, trust tiers per entry, and **holding a contradicting memory for a human
  decision instead of overwriting**.
- **The DSH ecosystem** — `engramory` for the `ctx.tools.guard()` primitive, `dsh-memento`
  for loud-not-truncating budgets and session-frozen snapshots, `dsh-memoir` for
  prefix-cache-aware injection.

Full tables, sources and line-referenced seam evidence: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Design in one picture

```
user turn ──▶ agent/post-step
                 │  skip if the main agent already wrote memory this turn
                 │  skip if the user turn carried no substantial prose
                 │  skip if the cursor did not advance
                 ▼  (coalescing: only the newest snapshot survives)
              mint the writer ──▶ restrict({deny}) + guard(...)   ← the whole point
                 ▼
              writer reads the manifest, writes candidates inside the room
                 ▼
              admission: path safety · cap (loud) · conflict hold · secret screen
                 ▼
              accept → versioned write → index rebuild → audit row
              hold   → needs a human decision
```

The main agent sees the index and a manifest of filenames plus descriptions. **Topic
bodies are never injected automatically** — the model reads them on demand.

## Install (when it is ready)

```sh
dsh plugin --profile web add dsh-zcode-scribe
dsh --profile web --dump-config | grep -A3 'id: scribe'    # rows collide ⇒ hard boot failure
```

## Develop

```sh
node test/run.mjs          # all suites
```

Requires Node `>= 20`. No runtime dependencies — the plugin imports `node:` builtins and the
host's peer packages only.

## License

MIT.
