# PUBLISHING

How a version of this plugin reaches npm and the plugin markets. The short form
lives in `CONTRIBUTING.md`; this is the long form, including the parts that fail
quietly.

---

## 1. Guards first, always in this order

```bash
export PATH="$HOME/.local/bin:$PATH"          # WSL non-login shells have no node on PATH
node test/run.mjs                             # 1. tests (this is what updates the documented counts)
node tools/verify-translation-pairing.mjs --write   # 2. re-record pairing hashes
node tools/verify-doc-numbers.mjs             # 3. re-check every documented number
bash -n install.sh && bash -n uninstall.sh    # 4. shell syntax
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2   # 5. needs --dsh
```

The order is not cosmetic. Changing a test count changes a number in the docs;
re-recording the pairing hashes happens **after** both language sides are updated;
the number guard runs **last** so it sees the final state. Step 5 runs once per
matrix entry in CI and **must** be given `--dsh` — without it the guard has nothing
to assert against and exits 1 rather than guessing.

`--write` on step 2 is a *declaration*, not a check: it records "the two sides
agree as of now". Running it without having actually updated both sides produces a
green guard over a lie.

## 2. Bump the version everywhere it is stated

`package.json` is not the only place. The number guard fails when these drift:

- `package.json`
- `README.md` and `README.zh.md`
- `SECURITY.md` and `SECURITY.zh.md` (support table)
- `CHANGELOG.md` and `CHANGELOG.zh.md`

## 3. Commit, tag, push

```bash
git add -A && git commit -m "feat(0.1.0): …"
git tag -a v0.1.0 -m "v0.1.0"     # annotated, and the message is the version name
git push origin main && git push origin v0.1.0
gh run list --repo BOWLUNA/dsh-zcode-scribe --limit 6
```

## 4. A green publish job is not a published version

Two independent failures hide behind a green job:

- **Propagation lag.** npm took about 2.5 minutes to serve a new version when this
  was measured. `npm view <pkg> version` is the only check that counts.
- **A tag that is not `latest`.** `publishConfig.tag` is not reliably honoured, so
  `tools/publish-if-new.mjs` passes `--tag latest` explicitly and refuses to
  publish a version that already exists.

## 5. Unpack the tarball — this step is not optional

A green CI run and a new version number on npm prove that *a* package was
published. Only unpacking it proves that *this change* was.

```bash
cd /tmp && rm -rf tgz && mkdir tgz && cd tgz
curl -sL "$(npm view dsh-zcode-scribe dist.tarball)" -o p.tgz
tar xzf p.tgz
node -p "require('./package/package.json').version"
grep -rl 'scribe_recall' package/         # a string this release introduced
grep -rl 'path escapes the memory root' package/
```

Then record: version, commit, tag, CI run id, propagation time, the strings you
checked for, and anything left undone.

## 6. Tell users about the cooldown

pnpm's default `minimumReleaseAge` is 24 hours. Immediately after a release,
`dsh plugin --profile web add dsh-zcode-scribe` **silently resolves to the previous
version**. Pin it:

```bash
dsh plugin --profile web add dsh-zcode-scribe@0.1.0
```

pnpm then adds a `minimumReleaseAgeExclude` entry by itself.

## 7. The markets

| Market | How | Gate |
| --- | --- | --- |
| `awesome-dsh-plugin` (= dshmarket.com = the in-harness market) | PR changing `data/plugins/BOWLUNA__dsh-zcode-scribe--scribe.yml` | description must match the code; one PR changes one entry |
| `beancookie/awesome-dsh-plugin` | PR to the list | self-nominated repo > 10 stars |
| `bruc3van/awesome-dsh-plugin` | PR to the list | self-nominated repo > 10 stars |
| `dsh-market/dsh-market` | automatic, from the repository description | — |
| `2BingLing/dsh.market` | automatic, from description / topics | — |

**Search reads only the YAML `description`.** Not the README, not the npm
keywords. Multi-word queries must match inside a single field, and a Chinese
phrase must appear contiguously.

Two rules that get PRs rejected: the description must match the code (overstating
is the only real rejection reason), and one PR changes exactly one entry.

Alphabetical-order checks in some list repositories sort by the `owner/repo` found
in the URL, not by the displayed name — visually correct is not correct.

## 8. Repository decoration

Four things, all of which go stale silently:

```bash
gh repo edit --description "<one factual English sentence with keywords>"
gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness --add-topic dsh \
             --add-topic cordis --add-topic zcode --add-topic memory
```

- `dsh-plugin` is **required** — the markets that index by topic depend on it.
- `zcode` is shared by the five plugins of this family, so one search finds the set.
- The social preview (1280×640) has **no REST endpoint**: Settings → Social preview,
  in the browser. It is the only step in the whole flow that cannot be scripted.

  ```bash
  curl -sL https://github.com/BOWLUNA/dsh-zcode-scribe | grep -o 'og:image" content="[^"]*'
  # repository-images.githubusercontent.com = set; opengraph.githubassets.com = default card
  ```
