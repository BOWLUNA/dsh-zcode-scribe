# Changelog

English | [中文](CHANGELOG.zh.md)

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`dsh` compatibility is declared in `package.json` under `engines.dsh` and asserted by
`tools/verify-version-consistency.mjs`; the dsh versions named in a release's notes are the ones
CI actually ran.

A versioning note, because the history below is not a straight line: **0.1.x were
development-period records and were never published.** 1.0.0 is the first public release. The
version line is now shared by the five `dsh-zcode-*` plugins, which are five parts of one body
of work rather than five independent projects.

---

## [Unreleased]

### Added

- Nothing yet. Writes are the next milestone, and they are gated on the M0 probe described in
  `AGENTS.md`: before extraction can exist, it has to be demonstrated that a subagent's
  capability set can be narrowed through a public seam. If that cannot be done, extraction does
  not ship rather than falling back to the main agent writing memory with its full toolset.

### Fixed

- **1.0.0 as tagged cannot be installed.** `cordis.patch.yml` still named the package
  `dsh-scribe` after the rename to `dsh-zcode-scribe`, and the loader resolves that field as a
  module specifier from the profile directory while applying the tree — so the profile died
  with `Cannot find package 'dsh-scribe'`. It installed, passed every unit test, and produced a
  clean `--dump-config` with an empty stderr; none of those applies the plugin, which is why
  CI was green. The row `name` now matches `package.json`.
- `tools/verify-boot.mjs`: a guard that installs the plugin into a throwaway `DSH_HOME` and
  boots it, requiring a listening URL and an empty stderr. It also checks the row
  `name`/package-name invariant directly, because `--dump-config` carries no resolution marker
  on this harness line to check instead. Runs in both workflows.
- `test/run.mjs` pins `--test-reporter=tap`. Node 24 changed the default reporter for a non-TTY
  stdout from `tap` to `spec`, which stopped `tools/verify-doc-numbers.mjs` reading the live
  summary on Node 24 while it kept working on Node 22.
- `release.yml` creates the GitHub Release from the tag. It declared `contents: read` and had
  no such step, so pushing a tag updated the code and left the Releases panel untouched.

---

## [1.0.0] — 2026-09-21

First public release. **Read-only, and deliberately so.** This release exists to establish three
safety properties in code, with tests, before any of them has to be defended under a feature
nobody wants to give up.

### Included

- Long-term memory for DeepSeek Harness whose writer is a narrowed subagent. 1.0.0 ships the
  **read half** and says so, in the README status banner and in the tool's own description.
- `scribe_recall`, a read-only tool returning the memory index, a manifest of topic filenames
  with their one-line descriptions, and optionally one topic body in full. Bodies are never
  injected automatically.
- The memory-room path rules: four normalisations (Unicode control and bidirectional characters,
  NTFS alternate data streams, trailing dots and spaces, platform-dependent case folding) plus a
  segment denylist evaluated against the path **relative to the memory root**.
- A 200-line / 25 000-character index cap whose truncation is **always reported**, naming the
  dimension, the current value and the limit. Silent truncation is never acceptable.
- A prompt snapshot frozen when a session's prompt is first assembled, which keeps the prefix
  cacheable and stops a retrieval from rewriting the instructions of the session that caused it.

### Compatibility

- Developed and verified on dsh `0.1.5-rc.2` (Windows desktop) and dsh `0.1.6-alpha.2` (WSL).
  Both lines are in the CI matrix, and `engines.dsh` declares exactly that pair.
- Host APIs used: `ctx.logger`, `ctx.tools.register` (inside `ctx.effect`), and
  `ctx.systemPrompt.section`; plus `defineTool` from `@deepseek-ai/dsh-tools` and the schema DSL
  from `@deepseek-ai/schemastery`. The session workspace is read from
  `exec.agent.session.header.cwd`.
- `--dump-config` is not a boot test — it composes configuration and never applies plugins, so it
  reports a clean tree for a profile that cannot start. `docs/TROUBLESHOOTING.md` records what
  that cost.

### Not yet

- Writes, extraction, and the narrowed writer itself. Tool names are prefixed `scribe_` because
  tool names are global per host and a duplicate is a hard boot failure; `dsh-memento`, the plugin
  this one is designed to compose with, already owns `memory` and `memory_recall`.

---

## [0.1.0] — 2026-09-21

Development-period record, never published and never tagged. It marks the point where the read
half, the path rules and the guards first ran green together. Kept so the history of the safety
decisions is not lost; for what actually shipped, read 1.0.0.

[Unreleased]: https://github.com/BOWLUNA/dsh-zcode-scribe/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BOWLUNA/dsh-zcode-scribe/releases/tag/v1.0.0
[0.1.0]: https://github.com/BOWLUNA/dsh-zcode-scribe/compare/v0.1.0...v1.0.0
