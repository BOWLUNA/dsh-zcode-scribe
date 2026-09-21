# dsh-scribe — design

> **Status:** design of record, first increment. Supersedes the pre-research sketch in
> `DSH插件项目/04-dsh-memory.md` (which assumed a hand-rolled extraction loop; see §6.1).
>
> **One line:** a long-term memory capability for DeepSeek Harness whose writer is a
> **narrowed subagent** — the only agent in the process that may touch memory, and only
> inside the memory room.

---

## 1. Why this exists at all

The DSH plugin market lists **190 plugins under `memory`** (catalog snapshot
`.zcode-src/dsh-market-catalog.json`, 2026-09-20, 4,062 entries total). Long-term memory
is not an empty niche. Writing "the 191st memory warehouse" would be waste.

So this project is not justified by a missing *feature*. It is justified by a missing
**safety property**. Three of them, in fact, and they were found by inspecting what the
existing 190 actually do rather than what their descriptions claim.

### 1.1 What the landscape covers (verified by unpacking tarballs, not by reading blurbs)

| Class | Representative | What it gets right |
| --- | --- | --- |
| Curated file store | `engramory` (191★) | one fact per file; `MEMORY.md` capped at 200 lines / 25 KB, enforced by `ctx.tools.guard()` |
| Capability seam | `dsh-memento` (108★) | `ctx.memory` service, local SQLite, **approval gate on every write path**, audit table |
| Cache-aware engine | `dsh-memoir` (28★) | token-bounded Hot Memory, frozen snapshot per session (prefix-cache stable), BM25 recall |
| Layered distillation | `dsh-layered-memory`, `dsh-meow-memory`, `dsh-mnemonic` | L0→L3 capture, seven-layer SQLite stores, entity graphs |
| External memory banks | `OpenViking`, `hindsight`, `ReMe`, `memsearch` | mature upstreams; all require a self-hosted service or a vector cloud |

### 1.2 The three gaps, stated precisely

| # | Property | Verified state across the 190 |
| --- | --- | --- |
| ① | **Hard permission narrowing for the writer** — the component that decides *what to remember* runs with a reduced capability set enforced at the tool-use boundary, not asked politely via prompt | **Zero coverage.** `engramory` is a *guard*, not an engine (438 lines: one `ctx.tools.guard()` cap + a skill that states the convention). `dsh-memento` gates writes with human approval — a different mechanism, and it does not spawn a writer. `dsh-memoir` steers a distill prompt inside the *main* agent, which still holds every tool it had. |
| ② | **Skip conditions** — don't run extraction when it cannot produce anything | **Partial.** `dsh-memoir` has `autoDistillMinTools` / `autoDistillEvery` / `autoDistillCooldownMin` — throttles by *tool-call count*. Nothing keys off "the user actually said something substantial" or "the main agent already wrote memory this turn". |
| ③ | **Path safety on the write path** — sensitive-segment denylist evaluated *relative to the memory root*, Unicode bidi/control stripping, Windows NTFS alternate-data-stream truncation, containment check | **Zero coverage.** `dsh-memento` sidesteps it by never writing workspace files (it owns a SQLite file under `$DSH_HOME`). Every markdown-based option leaves this unaddressed. |

### 1.3 Why ① and ③ are not paranoia

This is not a hypothetical hardening exercise. Memory is an *attack surface*, and it is
now a named one.

**Officially required.** Anthropic's memory-tool documentation states the client-side
handler *"must reject paths outside `/memories`"*, and that restricting operations to the
memory directory *"is not optional for any agent with write access to persistent
storage."* Their managed memory-store docs go further, advising that write permission be
**scoped to the sessions that actually add memories**, "so the origin of growth is easier
to trace."

**Named in a Top 10.** **OWASP ASI06 — Memory & Context Poisoning** was added to the
Agentic Top 10 for 2026. Memory differs from ordinary prompt injection in one decisive
way: *it survives the session*. Payloads arrive through a README, a web page, an email,
a tool result — and activate days later, when a benign query retrieves them.

**Measured, and measured badly for defenders.**

| Result | Source |
| --- | --- |
| **98%** injection success (GhostWriter) | arXiv/alphaXiv overview 2607.06595 |
| **~60%** activation even with polite, descriptive phrasing | same |
| **0%** detection by existing one-turn injection filters (DataFilter, PromptArmor) | same |
| **95%+** injection success (MINJA), **80%+** at <0.1% poison rate (AgentPoison) | collected in *Memory as Attack Surface* |
| AM-Sentry's admission policy + retrieval screen cuts success to **<12%** | 2607.06595 |

Two of the attack patterns in that literature are *literally* what ③ defends against:
**hidden payloads** — "Base64 blobs, **zero-width Unicode**, homoglyph obfuscation" — and
**memory eviction** — flooding the store to displace legitimate entries, which is what a
bounded index prevents.

And the framing that makes the whole thing unavoidable:

> Legitimate memory modification and malicious memory injection are technically identical
> operations. Same file, same write operation. The only difference is **intent**.

Intent is not observable. Capability is. So the design decision is: **do not try to detect
intent — remove capability, and constrain what remains.** That is what ① and ③ are.

### 1.4 Design borrowings

Everything below was learned from someone else. The row says what we take.

| Source | What we take |
| --- | --- |
| **Claude Code auto memory** | *Memory is an index, not storage* — "information that can be re-derived from the repo must never be stored". `MEMORY.md` = one line per memory; topic files loaded **on demand**, not at startup. **First 200 lines or 25 KB, whichever comes first.** A write that would exceed the cap **still succeeds, but returns an error telling the model to rewrite the index** — never a silent truncation. Near-limit → a proactive reminder. Subagent memory is a **separate directory**, and the main conversation's memory is **not** inherited by subagents. |
| **Claude Code `/.claude/rules/`** | Path-scoped rules load only when matching files are touched — the same "don't pay for what is irrelevant" instinct as the recall manifest. |
| **Anthropic memory tool** (`memory_20250818`) | Client-side handler owns storage; `/memories` is a prefix mapped to real storage; **path-traversal rejection is mandatory**. Commands: `view / create / str_replace / insert / delete / rename`. "Just-in-time context retrieval" — record, then read back on demand. |
| **Anthropic managed memory stores** | **Every change creates an immutable version** → audit trail and point-in-time recovery. Hard capacity cap where **writes fail loudly** (existing memories stay readable/editable). Prefer **several focused stores** over one large one. Consolidation ("dream") writes to a *new* store rather than mutating the source. |
| **AM-Sentry (2607.06595)** | Two-stage governance: an **admission policy** before storage, and a **retrieval screen** that re-checks a memory *in the context of the current query* before it enters the prompt. Stricter admission did **not** reduce utility — it improved it by filtering noise. |
| **Forcepoint memory-risk scoring** | Concrete risk signals worth adopting: `source_type` trust tiers (`OPERATOR > USER_VERIFIED > USER_OBSERVED > EXTERNAL_TOOL > EXTERNAL_WEB`); **contradiction detection holds the new memory instead of overwriting**; persistent-instruction phrasing ("remember this", "from now on", "always") raises risk. |
| **`engramory` (DSH)** | The `ctx.tools.guard()` shape as the enforcement primitive, and the insight that the guard must live *in code* because a prompt is a request, not a constraint. |
| **`dsh-memento` (DSH)** | Approvals, audit rows, hard per-track/per-scope character budgets that **return a structured error when full instead of truncating**, and freezing the injected snapshot once per session for prefix-cache stability. |
| **`dsh-memoir` (DSH)** | Cache-aware injection discipline, and the honest tradeoff note that per-turn distillation *steers model calls* and therefore costs tokens. |
| **`dsh-custom-mode`** (our own prior project) | Repository conventions: bilingual doc pairs with recorded blob hashes, the three verification guards in CI, an `AGENTS.md` invariants list, and "make the row id globally unique because a collision is a hard boot failure, not an override". |

### 1.5 What we deliberately do **not** do

- **No embeddings, no vector store, no network.** Recall is lexical + the model reading a
  manifest. This keeps the plugin zero-dependency and offline, and it is the honest choice:
  semantic recall is where the "usefulness vs. security" tradeoff gets silently resolved in
  favour of usefulness.
- **No new storage engine.** The store is plain markdown in a directory. It survives
  uninstalling the plugin, is readable in any editor, and can be put under git by the user.
- **No auto-overwrite on contradiction.** Conflicts are *held*, not resolved silently (§4.4).
- **No extraction without an explicit, narrowed writer.** If the narrowed subagent cannot
  be created, extraction does not fall back to the main agent holding full tools — it does
  not run (§6.1).

---

## 2. Product identity

```
package name   dsh-scribe
row id         scribe
category       memory
platforms      Windows / macOS / Linux (pure host — no native code, no network)
runtime deps   none (node: builtins only)
engines        node ^22.19.0 || >=24.0.0   dsh >=0.1.5-rc.2 <0.2.0-0
```

`scribe` is the row id: a scribe writes what it is told, and this one is only allowed to
write in the memory room. The name is the differentiator, so it should stay the first
sentence of the README.

---

## 3. Architecture

Every seam named here was read out of the installed packages
(`C:\BL\AI\DSH Desktop\resources\app\node_modules\@deepseek-ai\*`, dsh 0.1.5-rc.2), not
inferred. Line references are to those builds.

### 3.1 Seams actually used

| Need | Seam | Contract evidence |
| --- | --- | --- |
| Remove capabilities from the writer | `ctx.tools.restrict({ allow?, deny? })` | `dsh-tools/lib/index.js:2790`. **Requires a scoped context** (`agent.ctx`) — a context-global restriction throws by design. Unknown names, empty filters, scope-local names and `run_code` all **throw**. Restrictions intersect. Returns the exact disposer. |
| Constrain arguments of the tools that remain | `ctx.tools.guard(fn)` | `dsh-tools/lib/index.js:2816`. Synchronous, runs after the `tools/pre-execute` waterfall. **Returning a string denies.** Monotonic: any guard may deny, none may force-allow. Registered on `agent.ctx` it applies to that agent only. |
| Notice the writer being born | `ctx.on("agent/created", ({ agent }) => …)` | `dsh-agent/lib/index.js:543` emits it; `dsh-agent-presets/lib/index.js:1320` subscribes exactly this way — a shipped plugin doing it, so the pattern is supported, not incidental. |
| Trigger extraction | `ctx.on("agent/post-step", …)` | Listed among the emitted agent events (`agent/pre-step`, `agent/post-step`, `agent/status`, `agent/inbox/*`). |
| Inject index + manifest | `ctx.systemPrompt.section({ name, order, text })` | `dsh-system-prompt`. `dsh-custom-mode` uses the same seam. Order budget: harness identity is `-100`, persona `0` — we sit at `-50`, the same slot `dsh-memento` chose, so memory text precedes persona. |
| Read / write memory files | `ctx.fs` (not `node:fs`) | The harness's own tool implementations use it; it is the seam that respects the workspace boundary. `node:fs` is used *only* for the guard's cheap `stat` on the pinned index path. |
| Mint the writer | `ctx.subagents` (`@deepseek-ai/dsh-subagent`) | Service name `subagents` (`dsh-subagent/lib/index.js:2853`). Its `materializeTracked` runs a `setup(childCtx, child)` callback before the child starts — **`childCtx` is the scoped context `restrict()`/`guard()` require.** |
| Announce ourselves in `AGENTS.md` ordering | `dsh-agent-instructions` | Instruction files are injected as a *user* message after the system prompt. Our section must not assume it is alone. |

> **Why this is better than the original plan.** `DSH插件项目/04-dsh-memory.md` assumed the
> extraction subagent needed a hand-rolled mini-loop over `ctx.llm`, precisely *because*
> permissions had to be narrowed and `dsh-subagent` looked unable to express that. With
> `restrict()` and `guard()` being **scope-aware**, the native subagent can be narrowed
> after all. We keep the platform's own agent loop, its cancellation, its session log and
> its approval plumbing instead of reimplementing them. See §6.1 for the fallback rule if
> the scoped hook turns out to be unreachable in some profile.

### 3.2 Two-layer enforcement — remove, then constrain

The single most important design decision. ZCode's original policy function decided *at
call time* whether to allow a call. That is one layer. We use two, because they fail
differently:

```
layer 1 — REMOVE      ctx.tools.restrict({ deny: [...] })      on the writer's agent.ctx
  The tool is not in the writer's tool list at all.
  Cannot be tempted, cannot be prompt-injected into, invisible in the schema.

layer 2 — CONSTRAIN   ctx.tools.guard(exec => string|undefined)  on the writer's agent.ctx
  For tools that must stay available (read a file to summarise it) but whose ARGUMENTS
  must be policed (write only .md inside the memory room; rm only a contained, absolute,
  non-glob, non-recursive .md).
```

Layer 1 is what a prompt cannot fake. Layer 2 is what layer 1 cannot express, since
"read files" must stay possible while "read `~/.ssh/id_ed25519`" must not always be.

**Deny list for the writer (layer 1), by intent:**

| Denied | Why |
| --- | --- |
| `bash`, `run_code` | Arbitrary execution is the whole game. A read-only shell allowlist is a parsing problem we refuse to own. |
| every `mcp__*` | Third-party tool descriptions are themselves a documented injection vector (MCP tool poisoning; MCPTox measured 72.8% success on a leading model). |
| `web_fetch`, `web_search`, `tool-web` | The writer must not be able to fetch instructions. |
| `tool-subagent*`, subagent control | No recursive delegation — a narrowed writer must not mint an un-narrowed grandchild. |
| `present`, attachment/upload tools | Exfiltration channels. "Slow exfiltration" uses exactly these. |
| anything the deployment marks as network-scoped | Fail-closed on unknown side-effect scopes. |

The list is **config-driven with a fail-closed default**, and `restrict()` throwing on an
unknown name is a feature: a profile that lacks `web_fetch` (a headless one, say) must not
break our boot, so names are filtered against `ctx.tools.view(scope).restrictableNames`
before being passed, and *that* set is what we deny.

### 3.3 The memory room

```
<memoryRoot>/                     default: <workspace>/.dsh/memory/
├── MEMORY.md                     the index — injected every turn, hard-capped
├── user-preferences.md           one topic file per memory, YAML frontmatter
├── project-auth-refactor.md
└── .scribe/                      plugin-private bookkeeping (not memory)
    ├── state.json                cursor, per-session counters
    └── versions/                 immutable pre-write copies, for rollback (§4.5)
```

`MEMORY.md` frontmatter-free, one pointer line per memory:

```
- [project] project-auth-refactor.md (2026-09-21T08:12Z): JWT migration plan and rollback
```

Topic file:

```markdown
---
description: JWT migration plan and rollback steps
metadata:
  type: project
  trust: user-verified
  source: session-3f9a…:turn-14
modified: 2026-09-21T08:12:00Z
---

body…
```

Four types, copied deliberately from the vocabulary that Claude Code, ZCode and most of
the landscape converged on: `user` (facts about the person), `feedback` (corrections —
"don't do this again"), `project` (conventions, decisions, architecture), `reference`
(pointers to external resources).

### 3.4 Flow

```
                 ┌────────────────────────────────────────────────────────┐
user turn ──────▶│ agent/post-step                                        │
                 │   skip if:  main agent already wrote memory this turn   │  ← ② a
                 │   skip if:  user side had < minUserWords of prose       │  ← ② b
                 │   skip if:  cursor did not advance                      │
                 └──────────────────┬─────────────────────────────────────┘
                                    │ coalescing: keep only the newest snapshot
                                    ▼
                 ┌────────────────────────────────────────────────────────┐
                 │ mint writer via ctx.subagents                          │
                 │   setup(childCtx, child):                              │
                 │     childCtx.tools.restrict({ deny: DENY })            │  ← ① layer 1
                 │     childCtx.tools.guard(writePolicyGuard)             │  ← ① layer 2
                 └──────────────────┬─────────────────────────────────────┘
                                    ▼
                 ┌────────────────────────────────────────────────────────┐
                 │ the writer reads the manifest, then Read/Write/Edit    │
                 │ inside the memory room. Nothing else is reachable.     │
                 │   → candidate memories, each with trust + source       │
                 └──────────────────┬─────────────────────────────────────┘
                                    ▼
                 ┌────────────────────────────────────────────────────────┐
                 │ admission (in-process, no model call)                  │
                 │   path safety (§4.2) · cap check (§4.3) · conflict     │
                 │   detection (§4.4) · secret screen (§4.6)              │
                 └──────────────────┬─────────────────────────────────────┘
                                    ▼
              accept ──▶ versioned write ──▶ index rebuild ──▶ audit row
              hold   ──▶ .scribe/pending/  (conflict: needs a human decision)
              reject ──▶ structured reason returned to the writer
```

### 3.5 What the main agent sees

1. A **frozen snapshot** (index + manifest header) in the system prompt, captured once at
   first assembly and never mutated mid-session — prefix-cache stability, and it also means
   a poisoned retrieval cannot rewrite the agent's own instructions *within* the session
   that wrote it.
2. A `memory` tool for explicit asks ("remember this"): `add / replace / remove / query`.
3. A `/memory` command (list, show, audit, conflicts, prune, export).

Topic bodies are **never** injected automatically. The model reads them on demand, which is
both the Claude Code behaviour and the cheaper choice.

---

## 4. The safety mechanisms, precisely

### 4.1 Threat → mechanism map

| Threat (from §1.3) | Mechanism here |
| --- | --- |
| Instruction override stored as a "fact" | trust tiers + admission phrasing screen (§4.4, §4.6) |
| Concealment ("don't tell the user") | admission screen; every write is audited and visible in `/memory audit` |
| Trigger activation ("when the user says X, do Y") | retrieval screen re-checks a memory against the current query (§4.4) |
| Credential capture | secret screen refuses to store key-shaped material (§4.6) |
| Hidden payloads (zero-width Unicode, bidi, homoglyph) | Unicode control/bidi stripping on every **path** segment (§4.2) and on stored text |
| Memory eviction (flood to displace) | hard cap + non-silent over-cap error (§4.3) |
| Path escape / write outside the room | relative-to-root denylist + containment check (§4.2) |
| Windows NTFS ADS (`file.md:hidden`) | segment truncation at `:` (§4.2) |
| Slow exfiltration | writer cannot reach network, present, or upload tools (§3.2) |
| Tool permission drift | the writer's capability set is *declared in code*, re-applied per child, never learned |
| Poisoned memory editing the instructions of the session that wrote it | snapshot frozen at session start |

### 4.2 Path safety (gap ③)

Evaluated on the path **relative to the memory root** — not on the absolute path, since the
room itself lives under a dotted directory that would otherwise trip our own denylist.

```
normalizeSegment(segment):
  lowercase
  strip control chars and bidi overrides
     U+200C–U+200F, U+202A–U+202E, U+206A–U+206F, U+FEFF
  truncate at the first ':'        # NTFS alternate data stream
  strip trailing '.' and ' '       # Windows normalises "foo." to "foo"

sensitiveSegments = { .git, .ssh, .aws, .gnupg, .dsh, .zcode,
                      hooks, .husky, .githooks, node_modules,
                      .vscode, .idea, head, config, objects, refs,
                      skills, commands, agents,
                      .cargo, .devcontainer, .yarn, .mvn }

contains(root, resolved):
  rel = relative(root, resolved)
  rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
  && !isAbsolute(rel)
```

Every one of the three normalisation steps corresponds to a real attack, and two of them
are listed verbatim in the poisoning literature. They are not hygiene theatre.

### 4.3 Cap — the failure mode must be loud (borrowed, and stricter than the market)

- `indexLineLimit` = 200, `indexCharLimit` = 25 000. Claude Code's numbers, because they
  are the only empirically-tuned ones published.
- Over-cap **writes still succeed** and the writer receives a structured error naming the
  dimension, the current value, the limit, and the required action. Silent truncation is
  banned: it is how an agent ends up believing it saved something it did not.
- Between 80% and 100% the writer gets a *shrink this* reminder before it writes.
- Truncation of the **injected** copy is separate and always accompanied by a visible
  warning line — the loaded text and the stored text are allowed to differ, but the model
  is told they do.

### 4.4 Admission, conflict, and retrieval

- **Contradiction detection**: if a candidate overlaps an existing entry on the same
  subject but asserts something different, we **hold** it in `.scribe/pending/` and surface
  it in `/memory conflicts`. We never silently overwrite. (Borrowed from Forcepoint's risk
  engine; matches Claude Code's "stale memory is a liability" without adopting its
  automatic rewrite.)
- **Retrieval screen**: before a manifest entry is promoted into the prompt, a cheap
  in-process check tests whether the entry reads like an instruction aimed at the current
  query ("always", "from now on", "ignore previous", imperative + second person). Suspicious
  entries are shown *flagged and quoted as data*, never as guidance.
- **Trust tiers** are recorded per entry (`operator > user-verified > user-observed >
  external-tool > external-web`) and are visible in the manifest. Trust is **never**
  auto-upgraded by repetition — that is precisely the drift attack.

### 4.5 Rollback

Every accepted write first copies the previous file into `.scribe/versions/<timestamp>/`.
`/memory rollback <id>` restores it. This is the same property Anthropic's memory stores
get from immutable versions, implemented without a database: a directory of files the user
can inspect with an ordinary file manager.

### 4.6 Secret screen

Refuse to store anything matching high-confidence credential shapes (private-key headers,
common token prefixes, long high-entropy assignments). A memory file is a plain file that
users put under git; a captured key must never be the first thing that leaks.

### 4.7 What this design explicitly does not claim

It does not "solve memory poisoning". The literature is clear that semantic attacks are not
reliably detectable (`0%` detection by one-turn filter vendors) and that usefulness and
safety trade off. What it claims is narrower and checkable:

- a component that decides what to remember **cannot reach** the network, a shell, MCP
  servers, subagents, or any file outside the memory room;
- every escape path we can name in §4.1 has a mechanism, and every mechanism has a test;
- nothing is written silently — writes are audited, versioned, and over-cap writes fail
  with a message rather than a lie.

---

## 5. Non-goals

- Not a vector store. Not a knowledge graph. Not a RAG pipeline.
- Not a network service, not a sync daemon, not a multi-user product.
- Not a replacement for `AGENTS.md` / `CLAUDE.md`: those are *instructions the user writes*;
  this is *learnings the agent accumulates*. They are different objects with different
  owners and must not be merged. (Claude Code makes the same separation.)
- Not an embedding of the model's own chain of thought. We store facts, decisions and
  corrections — things a future session would otherwise have to be told again.
- Not a competitor to `dsh-memento`. `memento` is a *capability seam* (a service other
  plugins can build on, with approvals). `scribe` is a *writer with a reduced capability
  set*. They compose: an adapter could route accepted `scribe` writes through `memento`'s
  `ctx.memory` service. If you want one of them, and you do not specifically need a narrowed
  writer, install `dsh-memento` — it is the more mature option today.

---

## 6. Honest risks

### 6.1 The scoped-context hook is the load-bearing assumption

`restrict()` and `guard()` both throw when given a context-global scope, and
`dsh-subagent`'s `setup(childCtx, child)` looks like the right place to attach them. That
has been **read, not yet run**. Two failure modes and their answers:

| If | Then |
| --- | --- |
| `setup` is not reachable from a plugin in some profile | Fall back to `ctx.on("agent/created")` + match the child's descriptor. If that also fails: |
| the writer cannot be narrowed at all | **Extraction does not run.** It does not degrade into the main agent doing the writing with full tools — that would silently delete the only property this plugin exists for. Read/query/manual-`memory`-tool modes still work. |

The first implementation milestone is a throwaway probe that proves a scoped restriction
actually removes a tool from a child agent's visible set — **before** anything is built on
top of it. See `AGENTS.md`.

### 6.2 Cost

Extraction is a model call. `dsh-memoir` was rejected as our first pick precisely because
its per-turn distillation burns tokens. Mitigations, in order of effect: the two skip
conditions, cursor-based incrementality (only messages since the last run), coalescing
(newest snapshot wins; superseded ones are dropped), a configurable cheap extractor model,
and a per-session call ceiling.

### 6.3 The number of config knobs

Every knob is a way to disable a safety property. The defaults are the safe ones; anything
that weakens §4 must require naming the property it turns off.

---

## 7. Milestones

| # | Deliverable | Gate |
| --- | --- | --- |
| M0 | **Scope probe** — a throwaway plugin that mints a child agent via `ctx.subagents`, attaches `restrict({deny:["bash"]})`, and prints the child's visible tool names | The probe's output shows `bash` absent and no throw. Everything else is blocked on this. |
| M1 | `src/paths.mjs` + tests (this increment) | 20+ cases: traversal, bidi, ADS, trailing dot, containment, root-relative denylist |
| M2 | Read-only half: index + manifest injection, `memory` tool, `/memory` command | A hand-written `MEMORY.md` appears in the assembled prompt; a topic file's `description` shows in the manifest without its body |
| M3 | The narrowed writer: `agent/created` hook, deny list, guard, extraction prompt, skip conditions, cursor, coalescing | A poisoned session cannot make the writer touch anything outside the room; the two skip conditions fire |
| M4 | Admission: cap (loud), conflict hold, trust tiers, secret screen, versions + rollback | `/memory audit` reconstructs every write; over-cap returns a structured error |
| M5 | Retrieval screen + `/memory conflicts` | A planted instruction-shaped memory is surfaced as a conflict, not as guidance |
| M6 | Repository maturity: bilingual doc pairs + i18n hashes, three verification guards in CI, screenshots, CHANGELOG | CI green on Windows and Linux |
