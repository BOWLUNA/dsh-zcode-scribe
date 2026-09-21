# MEASUREMENTS — every claim, with the command that produced it

> Convention borrowed from `BOWLUNA/dsh-custom-mode`: a conclusion without a command and its
> raw output is not a conclusion. If a line below stops being true, fix the line — do not
> soften it.
>
> Environment: DSH Desktop `0.9.0` · `@deepseek-ai/dsh` `0.1.5-rc.2` (Windows) and
> `0.1.6-alpha.2` (WSL) · cordis `4.0.2` · schemastery `3.18.2`. Recorded 2026-09-21.

---

## 1. Unit suites

```
$ node test/run.mjs
# tests 101
# suites 15
# pass 101
# fail 0
```

Covers the path rules (52 cases), `apply()` behaviour (15), the read half + tool `execute()`
against a real temp-room on disk (34).

## 2. The row composes and boots (Windows, isolated `DSH_HOME`)

```bash
export DSH_HOME=".../.workbuddy/sandboxes/05/dsh-home"
"$NODE" "$BIN" plugin --profile web add "C:/BL/Work/WorkSpace/WorkBuddy/ZCode/05-dsh-scribe"
"$NODE" "$BIN" --profile web --dump-config > tree.txt 2> tree.err
```

```
exit=0   stderr=0 bytes   153 rows   duplicate ids: none
- id: scribe
  name: dsh-scribe
  config: { dir: .dsh/memory, indexLineLimit: 200, indexCharLimit: 25000, … 11 keys, all preserved }
  __dshPluginOwner: { packageName: dsh-scribe, version: 0.1.0, packageDir: …sandboxes/05/dsh-home/profiles/web/node_modules/dsh-scribe }
```

```bash
timeout 40 "$NODE" "$BIN" --profile web --port 31850 --no-open
```
```
dsh web: http://127.0.0.1:31850/?token=PUdD-…
stderr: 0 bytes
```

**`--dump-config` alone was not enough, twice.** The first real boot of this plugin failed
with `Cannot find package '@deepseek-ai/schemastery'` while the tree above was clean. Cause
and fix are in `AGENTS.md` § "`--dump-config` is not a boot test".

## 3. The tool is registered *and executes* inside a live host

Probe: `_probes/05-scribe-probe.mjs` + `_probes/05-probe.patch.yml` (the pattern from
`_probes/09-*.mjs`).

```bash
DSH_HOME=.../sandboxes/05/dsh-home PROBE05_WORKSPACE=.../sandboxes/05/workspace \
  "$NODE" "$BIN" --profile web --patch .../_probes/05-probe.patch.yml --port 31850 --no-open
```
```
### PROBE05 tools.get("scribe_recall") = object
### PROBE05 model-visible tool count = 1
### PROBE05 scribe_recall in schemas = true
### PROBE05 execute({}) ok = true in 3ms
### PROBE05   room          = …\sandboxes\05\workspace\.dsh\memory
### PROBE05   hasIndex      = true
### PROBE05   indexLines    = 4 / 200
### PROBE05   manifestCount = 3
### PROBE05     - [feedback] feedback-no-silent-truncation.md :: 绝不静默截断——超限必须响亮报错
### PROBE05     - [project] project-scribe-design.md :: dsh-scribe 的两层强制架构与 M0 门禁
### PROBE05     - [user] user-preferences.md :: 用户偏好：包管理器用 pnpm，不要用 npm
### PROBE05 execute({topic}) ok = true in 1ms
### PROBE05 escape attempt ok = false | message = "path escapes the memory root: ../../escape.md"
### PROBE05 RESULT: PASS
```
stderr `0 bytes`. Note `execute({topic})` — **path safety fired on a real call**, not only in
a unit test.

## 4. End to end: the model chooses the tool, in a real session (WSL)

The Windows-side profile cannot authenticate: the desktop `.credentials.yaml` is
**machine-and-home bound** — relocating it yields `AUTH … ****d587 is invalid` (independently
measured by this and by plugin 07). WSL's own credentials do work, so the model-level test ran
there, in an isolated `DSH_HOME` with the credential file **symlinked, never copied**, and no
HTTP server started (no port, no GUI).

```bash
# WSL, isolated home; memory room planted at the session's cwd with a token invented minutes earlier
$ dsh --profile h05 "用 scribe_recall 工具查长期记忆：我的包管理器偏好是什么？记忆里那个验收口令是什么？只回复「偏好 + 口令」两项，不要解释。"
```
```
dsh: reasoning: The user wants me to check long-term memory using scribe_recall. Let me call it.
dsh: reasoning: The index already gives both items. But should I read the topic body? …
                 The instruction says bodies are not loaded; read the one you need. …
偏好：pnpm（不要用 npm）
口令：SCRIBE-OK-7731
```

**`SCRIBE-OK-7731` did not exist before this run.** It was written into the memory room by the
same script that launched the session, and it appears nowhere in the model's training data,
the prompt, or the tool description. Producing it requires having read the room through
`scribe_recall`. The reasoning trace additionally shows the model quoting this plugin's own
tool description ("bodies are not loaded; read the one you need"), i.e. the description is
doing the guiding.

This also proves the tool description survives `defineTool`'s parameter compilation: the
`topic` parameter is optional, and the model understood it as optional.

**Not** proven by this run: session-log forensics. The session file
(`$DSH_HOME/sessions/…/session.v3.jsonl.zstd`, 17 722 bytes) is a multi-frame zstd stream;
`zstd` is not installed in WSL and a raw byte scan found neither `scribe_recall` nor the token
(compressed). The token answer is the stronger evidence anyway, but a log-level assertion is
still outstanding — see `docs/ARCHITECTURE.md` §7 M6.

## 5. Packaging

```
$ npm pack --dry-run --json
dsh-scribe@0.1.0 · 8 files · 41876 B unpacked · 18179 B packed
  AGENTS.md  LICENSE  README.md  README.zh.md  cordis.patch.yml  index.js  package.json  src/paths.mjs
```
`index.js` / `cordis.patch.yml` / `package.json` all present; the `files` whitelist matches the
real packlist.

## 6. Host API facts learned the hard way

| Fact | How it was learned |
| --- | --- |
| `defineTool` wraps `execute` so it **always returns a Promise** | 11 test failures, then a direct call |
| The `parameters` authoring DSL **rejects `required: false`** — optionality is the *absence* of the key. The rejection is a `defineTool()`-time throw, i.e. a boot failure | `UNSUPPORTED_SCHEMA: parameters.topic.required must be true when present` |
| `defineTool` wraps `isConcurrencySafe` as `(args) => validate(args).length > 0 ? false : user(args)`, and the host calls it with the real arguments (`dsh-tools/lib/index.js:2955`) | reading the wrapper's own source, then tests |
| `ctx.tools.register` validates only `output.schema` and stores the definition verbatim — skipping `defineTool` ships the authoring DSL to the provider, which then rejects the whole function schema | `dsh-tool-git`'s inline note; re-confirmed here |
| A `link:`-installed plugin resolves bare imports from **its own real path**, so a repo needs `node_modules/@deepseek-ai` (a Windows **junction** is followed by WSL too — one junction serves both) | boot failure, then the same junction working in both environments |
| `agent.session.header.cwd` is how a tool learns the session workspace (`dsh-tool-git/src/exec.js:284`) | reading a sibling plugin |
| The WSL dsh line is `0.1.6-alpha.2` while the desktop line is `0.1.5-rc.2`, so a peer range **must carry a prerelease comparator for each line** — `^0.1.5-rc.2` does not match `0.1.6-alpha.2` | `dsh --version` in WSL, then node-semver's rule |
