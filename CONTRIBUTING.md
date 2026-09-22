# Contributing
English | [中文](CONTRIBUTING.zh.md)

Thanks for looking. This file covers how to run things and what will be checked. The
reasoning behind the rules is in `AGENTS.md` (the machine-facing list) and
`docs/ARCHITECTURE.md`.

## Setting up

Node `>= 20`. There are no runtime dependencies and no build step.

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-scribe
cd dsh-zcode-scribe
node test/run.mjs          # 104 tests, 16 suites, no install required
```

The suites import two host packages, `@deepseek-ai/dsh-tools` and
`@deepseek-ai/schemastery`. In CI they come from installing a harness; locally they
usually come from the harness you already have. `docs/TROUBLESHOOTING.md` explains the
`node_modules/@deepseek-ai` junction that makes this work for a checkout.

## Before you push

```bash
node test/run.mjs                                   # 1. tests
node tools/verify-translation-pairing.mjs --write    # 2. only if a document changed
node tools/verify-doc-numbers.mjs                   # 3. documented numbers
bash -n install.sh && bash -n uninstall.sh          # 4. shell syntax
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2   # 5. needs --dsh
```

Step 2 is a **declaration**, not a check: it records that the two language sides agree
as of now. Run it only after actually editing both. Step 5 asserts that a given dsh
version falls inside the range this package declares, and it **needs** `--dsh` —
without an argument it exits 1 rather than guessing.

## Two rules that matter more than style

**A safety property is not a feature toggle.** The three properties described in
`docs/ARCHITECTURE.md` §1.2 are why this plugin exists. A change that weakens one must
say, in the diff, which property it trades away and what replaces it. A config key that
disables one must name the loss in its own comment.

**Every rule gets a test that fails when the rule is removed.** A rule with no test is
a comment. If you add a guard, add the mutation that proves the guard fires.

## Documents

Documents that a user reads exist twice, `X.md` (English) and `X.zh.md` (Chinese), with
`X.i18n.yaml` recording the git blob hash of both sides as of the last confirmed
agreement. The two are the same document: edit one, edit the other, then re-record. The
pairing guard also checks language purity, so a half-translated file fails.

Use `.zh.md`, not `.zh-CN.md`.

The `docs/` design documents are English-only by declared policy — see
`tools/verify-translation-pairing.mjs`, which names them along with the reason and
prints the gap on every run.

## Scope discipline

Fixing seven things completely, each with a guard, beats touching fifteen and leaving
every one half-green. If a problem is real but out of reach of the change at hand, open
an issue rather than fixing it in passing — that is how a review stays readable.

## Pull requests

The template lists what must hold. Two points worth repeating:

- No credentials, tokens, or memory-room contents in a diff, a test fixture, or a log.
- If a documented number changed, both language sides were updated and the pairing
  hashes re-recorded. The reference project turned four CI matrices red once by
  changing a number and forgetting the second step.
