# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`dsh` compatibility is declared in `package.json` under `engines.dsh` and asserted
by `tools/verify-version-consistency.mjs`; the versions in a release's notes are the
ones CI actually ran.

---

## [Unreleased]

### Added

- Nothing yet. Writes are the next milestone, and they are gated on the M0 probe
  described in `AGENTS.md`: before extraction can exist, it has to be demonstrated
  that a subagent's capability set can be narrowed through a public seam. If that
  cannot be done, extraction does not ship at all rather than falling back to the
  main agent writing memory with its full toolset.

---

## [0.1.0] — 2026-09-21

The first release. **Read-only, and deliberately so.** It exists to establish three
safety properties in code, with tests, before any of them has to be defended under
a feature nobody wants to give up.

### Added

- **`scribe_recall`**, a read-only tool. It returns the memory index, a manifest of
  topic filenames with their `description` from frontmatter, and optionally one
  topic file in full. Topic bodies are never injected automatically — the model
  reads the one it needs, which is the cheaper and the more honest arrangement.
- **The memory-room path rules** (`src/paths.mjs`), applied to every read the tool
  performs. Four normalisations run before any comparison, each answering a real
  attack rather than a hypothetical one: Unicode control and bidirectional
  characters are stripped (U+202E renders a name as its reverse), a segment is
  truncated at the first `:` so an NTFS alternate data stream cannot hide a
  reserved name, trailing dots and spaces are removed because Windows normalises
  `foo.` to `foo`, and case is folded only where the filesystem folds it.
- **A root-relative segment denylist** covering security boundaries (`.git`,
  `.ssh`, `.aws`, `.gnupg`, `hooks`), harness-owned directories (`.dsh`, `skills`,
  `commands`, `agents`) and vendor state that is never memory (`node_modules`,
  `.vscode`, `.cargo`, …). It is evaluated against the path *relative to the memory
  root*, because the room itself legitimately lives under a dotted directory.
- **The index cap**, 200 lines or 25 000 characters, whichever is reached first —
  the pair Claude Code tuned and published. An over-cap load is truncated **with a
  warning naming the dimension, the current value and the limit**, because an agent
  that believes it saved something it did not is worse off than one that knows it
  was cut. Silent truncation is never acceptable.
- **A frozen prompt snapshot**, captured when a session's prompt is first assembled
  and never mutated afterwards. This keeps the prompt prefix cacheable and stops a
  retrieval from rewriting the instructions of the session that caused it.

### Notes

- **No writes, no extraction, no subagent.** `narrowWriter` and `refuseSecrets`
  exist as configuration and are documented as what they are; turning
  `narrowWriter` off names, in its own comment, which property is lost.
- Every tool is prefixed `scribe_` because tool names are global per host and a
  duplicate is a hard boot failure. `dsh-memento`, the plugin this one is designed
  to compose with, registers `memory` and `memory_recall`.
- Verified against dsh `0.1.5-rc.2` (desktop) and `0.1.6-alpha.2` (WSL). The
  tool-authoring DSL differs between them — `required: false` is rejected by one —
  which is why CI runs both.

[Unreleased]: https://github.com/BOWLUNA/dsh-zcode-scribe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BOWLUNA/dsh-zcode-scribe/releases/tag/v0.1.0
