# Security policy

## Supported versions

| Version | Supported | dsh lines tested |
| --- | --- | --- |
| 0.1.0 | yes | `0.1.5-rc.2`, `0.1.6-alpha.2` |

This project is pre-1.0 and has exactly one release line. Security fixes go to the
newest release only.

## Reporting a vulnerability

Open a private advisory at
<https://github.com/BOWLUNA/dsh-zcode-scribe/security/advisories/new>, or use the
contact link on the issue tracker. Please do not open a public issue for anything that
could be exploited before a fix exists.

Include the dsh version, the operating system, and — if you have it — a memory room and
a request that reproduces the problem. A reproducible path is worth more than a
description of one.

## What counts as a vulnerability here

This plugin exists to make three properties true, so an attack on any of them is a
security report rather than an ordinary bug report.

1. **The narrowed writer.** Anything that lets the component which decides what to
   remember reach a capability it is documented as not having — network, shell, MCP
   servers, subagents, the presentation and upload tools — is the most serious class
   of report this project can receive.
2. **Path safety.** Any input that makes `scribe_recall` read a file outside the
   memory room, or that makes a reserved segment resolve as an ordinary one. The four
   normalisations in `src/paths.mjs` each exist because an attack is possible without
   them: Unicode bidirectional overrides (U+202E renders a name as its reverse), NTFS
   alternate data streams (`notes.md:hidden`), trailing dots and spaces (Windows
   normalises `foo.` to `foo`), and case folding on the platforms that fold it.
3. **Silence.** A truncation, a refused write, or a dropped memory that the model is
   not told about. The index cap deliberately returns a warning naming the dimension
   and the limit; making that quieter is a regression in a security property, not a
   cosmetic change.

## Threat model

Memory is an attack surface. **OWASP ASI06 — Memory & Context Poisoning** entered the
Agentic Top 10 for 2026, and the published numbers are not close: a memory-poisoning
payload has been measured at 98% injection success with roughly 60% activation, and
existing one-turn injection filters detected it 0% of the time.

The difficulty is not that the payloads are clever. It is that legitimate memory
writing and malicious memory injection are **the same operation** — same file, same
write call. Only intent differs, and intent is not observable. So this plugin does not
try to detect intent. It removes capability and constrains what remains, and
`docs/ARCHITECTURE.md` maps each threat it names to the mechanism that answers it.

What this project does **not** claim: that memory poisoning is solved. Semantic attacks
are not reliably detectable, and usefulness trades against safety. The claims are
narrower and checkable, and `docs/ARCHITECTURE.md` §4.7 states exactly which ones.

## Scope

Not in scope: anything requiring an attacker to already control the harness process,
the user account, or the machine. This plugin has no network surface, no authentication
of its own, and no service to attack.
