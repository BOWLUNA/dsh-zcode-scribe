# Tests
English | [中文](README.zh.md)

```bash
node test/run.mjs
```

**130 tests across 18 suites**, with no installation and no harness required. The
runner discovers every `*.test.mjs` here, resolves them to absolute paths, and hands
them to `node --test`. It does that rather than letting Node discover a directory,
because a bare `test` argument resolves as an extension-less module path on Windows and
the run dies with `MODULE_NOT_FOUND` before a single assertion executes.

## The suites

| File | Suites | What it holds |
| --- | --- | --- |
| `paths.test.mjs` | 7 | The memory-room path rules: traversal, reserved segments, Unicode smuggling, NTFS alternate data streams, trailing-dot folding, platform-dependent case folding, all-or-nothing batches |
| `apply.test.mjs` | 3 | What `apply()` does to a live host: row identity, the safe config defaults, exactly one prompt section and one tool, the lifecycle effect, and the loud warning when `narrowWriter` is disabled |
| `recall.test.mjs` | 5 | Index capping (including that a cut is never silent), frontmatter reading, root resolution, and the tool's `execute()` against real directories on disk |

## What is deliberately not mocked

`recall.test.mjs` builds real directory trees in the OS temp directory and calls the
tool the way the host does. The interesting failures in the read path are filesystem
ones — a missing room, a topic that escapes it, an unreadable file — and a mocked
filesystem would test the mock.

The plugin is imported as the host imports it: the real `index.js`, never a
reimplementation of it.

## Intent is asserted on the plain definition, not the compiled tool

`recallDefinition()` returns the authoring object; `recallTool()` returns what
`defineTool` produced. Anything about *intent* — the name, the optional parameter, the
output contract, the concurrency declaration — is asserted on the definition, because
the host's wrapper is not a stable contract across dsh `0.1.5-rc.2` and `0.1.6-alpha.2`.
Only callability is checked on the compiled tool.

## Counting

The totals are documented numbers: `tools/verify-doc-numbers.mjs` compares every
`N tests` and `N suites` in the repository against a live run and fails the build when
one drifts. If you add a test, expect to update this file.
