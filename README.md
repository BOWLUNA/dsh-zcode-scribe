# dsh-zcode-scribe
`v0.1.0` · developed and verified against dsh `>=0.1.5-rc.2 <0.2.0 || >=0.1.6-alpha.1 <0.2.0`.

**Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) whose writer is a narrowed subagent.**

> **Status: early, and read-only.** The `scribe_recall` tool is registered, executes for real
> inside a live host, and a real model session on dsh `0.1.6-alpha.2` used it to answer from a
> memory room — [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) carries the raw output behind
> every claim below. 101 tests pass. What does **not** exist yet: writes, extraction, and the
> narrowed writer, which is gated on milestone **M0** — proving a subagent's capability set can
> actually be narrowed through a public seam. Nothing is injected into the prompt yet, so
> installing this changes what the model can *ask for*, not what it knows.

[简体中文](README.zh.md)

---

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
