# TROUBLESHOOTING

Every entry below was hit for real while building this plugin. The commands are the
ones that diagnosed or fixed it.

---

## The profile will not boot, but `--dump-config` is clean

```
Error: dsh: plugin tree failed to load: … Cannot find package '@deepseek-ai/schemastery'
       imported from …/dsh-zcode-scribe/index.js
```

`dsh plugin add <local-path>` installs a **`link:`** dependency. The code therefore
stays in your checkout, and Node resolves bare imports by walking up from
`index.js`'s *real* path — where the profile's `node_modules` is not on the chain.

Fix: give the checkout its own view of the host packages. A directory junction
does not need Administrator, whereas a symbolic link does.

```bat
:: Windows, elevated-free. Substitute your own repository path.
mkdir "<repo>\node_modules"
mklink /J "<repo>\node_modules\@deepseek-ai" "%DSH_INSTALL%\node_modules\@deepseek-ai"
```

`node_modules/` is git-ignored, so this is a per-checkout step; users installing
from npm never need it. A Windows junction is followed by WSL as well, so one
junction serves both environments.

**The general lesson: `--dump-config` composes configuration, it does not apply
plugins.** It exits 0 on a profile that cannot boot — the failure only appears when
the tree is really applied. Always do a real boot before believing a change is safe:

```bash
DSH_HOME=<throwaway> "$NODE" "$DSHBIN" --profile web --port 0 --no-open
```

### The same symptom when the row `name` goes stale after a rename

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
       failed to import loader entry scribe (dsh-scribe): Cannot find package 'dsh-scribe'
       imported from …/profiles/web/
```

This is the other way into the trap above, and it bit 1.0.0. The package had been
renamed from `dsh-scribe` to `dsh-zcode-scribe`; `package.json`, the repository and
the local directory were all updated, and `cordis.patch.yml` was not. The row's
`id` may be a short nickname (`scribe`), but its **`name` is a module specifier**,
resolved from the *profile* directory while the tree is applied — so it has to be
exactly the package name.

Two measurements from diagnosing it, both worth keeping:

- **`--dump-config` shows no trace of resolution either way.** `packageDir` and
  `__dshPluginOwner` are absent on dsh `0.1.6-alpha.2` whether the name resolves or
  not, and the dump is exit 0 with an empty stderr in both cases. Do not write a
  check that greps the dump for a resolution marker — there isn't one on this line.
  The one thing the dump *does* expose is the row itself, so the invariant is
  checkable: the row's `name` must equal `package.json`'s `name`.
- **A rename has four places, not three.** `package.json` `name`, the repository
  name, `cordis.patch.yml`'s row `name`, and the local directory name. Missing the
  third produces a plugin that installs, passes every unit test and passes
  `--dump-config`, and then takes the profile down. `tools/boot-check.mjs` asserts
  it (assertion B) and boots the result (assertion C).

## A guard that passes while testing nothing

`tools/boot-check.mjs` was written to catch the rename defect above, and its first
draft was worthless. The boot step spawned the harness without passing `env`, so
`DSH_HOME` was never set and the boot silently used the developer's own `~/.dsh` —
a profile that starts perfectly well. The guard printed PASS no matter what the
repository did.

It was found by mutating the repository on purpose and noticing that a mutation it
**should** have caught came back green. The rule that follows:

- **A guard is not finished until a mutation makes it fail, and you have seen which
  assertion failed.** "It passes on the good tree" says nothing.
- **Mutate each assertion separately.** Making the row `name` stale only proved
  assertion B; assertion C stayed unproven until a mutation was made that B does not
  look at — a module-level throw with the name left correct — and C went red on it.
- **A vacuous guard is worse than no guard**, because it converts "nobody checked"
  into "checked, and it is fine".

The same trap in a different costume: the test runner's output format. `test/run.mjs`
pins `--test-reporter=tap` because Node 24 changed the default reporter for a
non-TTY stdout from `tap` to `spec`, which turns `# pass 101` into `ℹ pass 101` and
leaves `tools/verify-doc-numbers.mjs` unable to read the live summary on one machine
and fine on another. Pin the format where it is produced; do not parse whatever the
environment happens to emit.

## The port answers before the tree is applied

Found while building `tools/boot-check.mjs`, and it invalidates the obvious version of
assertion C. With the row `name` correct and a module-level `throw` in `index.js`, the
harness **still accepted a TCP connection** on its port and only then exited with code 1:

```
boot-check: C. 127.0.0.1:31859 answered · exited early (code 1)
boot-check: D. stderr bytes: 0 at the moment the port answered · 7543 including teardown
boot-check: FAIL [C] the harness exited (code 1) right after answering — it never served.
```

The server starts listening before the plugin tree is applied, so "the port answers" on its
own has a hole shaped exactly like the defect this guard exists to catch. Two consequences:

- **Never assert C by connecting alone.** Hold the process alive for a beat after the first
  answer and fail if it died. That is what caught this case.
- **Assertion D is necessarily racy, and that is why C carries the weight.** The tree error
  had not been written when the port answered, so `stderr` was empty at that instant even
  though the boot was doomed. D still earns its place — it is what catches a plugin that
  boots and serves while complaining — but do not treat a clean D as proof that C is
  unnecessary.

The same measurement also settled a harness question: the **Electron** build in a
developer's `node_modules` never prints a listening URL, and driven from WSL it does not
bind the port at all (`exit=124`, both streams 0 bytes, nothing listening after 25 s) while
from Windows it does. That is why the check probes the port rather than a log line, and why
`$DSH_INSTALL` / an npm install is the better boot target.

## `required must be true when present`

```
UNSUPPORTED_SCHEMA: parameters.topic.required must be true when present
```

The tool-authoring DSL expresses optionality by **omitting** `required`. Writing
`required: false` throws at `defineTool()` time, which makes it a boot failure
rather than a warning. This is also one of the differences between dsh
`0.1.5-rc.2` and `0.1.6-alpha.2`, which is why CI runs both.

## A tool call returns `undefined` in a test

`defineTool` wraps `execute` so it **always returns a Promise**, even when the
implementation is synchronous. `await` it.

Its `isConcurrencySafe` wrapper also changed shape between the two supported dsh
lines. That is why this repository's tests assert on the plain definition
(`recallDefinition`) for anything about intent, and only check that the compiled
tool is callable.

## Tool name collisions are a hard boot failure

```
tool "git_status" is already registered (for a per-agent variant, register through
that agent's agent.ctx instead)
```

Tool names are global per host and a duplicate is **not** an override. This is why
every tool here is prefixed `scribe_`: the plugin this one is designed to compose
with, `dsh-memento`, registers tools named exactly `memory` and `memory_recall`.

## Authentication fails in a sandbox

```
MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

or, once the credential file has been copied across:

```
dsh: AUTH: Authentication Fails, Your api key: ****d587 is invalid
```

The desktop `.credentials.yaml` is bound to its machine **and** its data
directory, so relocating it does not work. For a real model session, the WSL side is
the reliable path: credentials resolve there, and `headless` needs no HTTP server at
all, so no port is occupied and no browser is involved.

```bash
# Isolated DSH_HOME. The credential is SYMLINKED, never copied or printed.
mkdir -p "$SB/profiles"
ln -s ~/.dsh/.credentials.yaml "$SB/.credentials.yaml"
export DSH_HOME="$SB"
dsh --profile probe --from-default-profile headless
dsh plugin --profile probe add /mnt/c/path/to/dsh-zcode-scribe
dsh --profile probe "use scribe_recall to tell me what you remember"
```

Do not touch a harness that is in use: its `dsh web` is serving someone's session.

## `EADDRINUSE` on a port nothing appears to be using

`dsh web` defaults to port 3080, which is frequently already held — and when the
holder is a WSL instance under `networkingMode=Mirrored`, Windows' `netstat` **does
not show it**. The result is a bind failure against a port that looks free.

Use `--port 0` and let the OS choose. Add `--no-open` too, unless you actually want
a browser window to appear.

## A memory file written mid-session is not seen by that session

By design. The injected snapshot is frozen when the prompt is first assembled, which
keeps the prompt prefix cacheable and stops a retrieval from rewriting the
instructions of the session that caused it. Read the file, or ask the agent to.

## A topic read is refused

The refusals are the point, and each carries exactly one reason string:

| Reason | Meaning |
| --- | --- |
| `path escapes the memory root` | the target resolved outside the room |
| `path segment is reserved` | a denylisted directory (`.git`, `.ssh`, `node_modules`, `hooks`, …) |
| `path segments cannot contain ':'` | an NTFS alternate data stream |
| `memory files must end in .md` | a non-markdown target |
| `the index is already returned in 'index'` | use the `index` field instead of re-reading `MEMORY.md` |

## The index says TRUNCATED

That is deliberate and never silent: the stored file exceeded 200 lines or 25 000
characters, so the injected copy was cut and a warning naming both dimensions was
appended. Shorten `MEMORY.md` by moving detail into topic files — the warning says
the same thing inside the prompt itself.
