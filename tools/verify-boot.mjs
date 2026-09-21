#!/usr/bin/env node
/**
 * Boot guard — the plugin must actually **install and start**.
 *
 * Every other guard in this repository runs against the plugin's pure logic or
 * its configuration. None of them applies it to a real harness, and the
 * difference is not academic. On 2026-09-21 this package shipped a 1.0.0 that
 * installed cleanly, passed 101 unit tests, and produced a `--dump-config` tree
 * with `exit 0` and an empty stderr — and then took the whole profile down at
 * boot:
 *
 *   Cannot find package 'dsh-scribe' imported from …/profiles/web/
 *
 * The cause was one stale word. `cordis.patch.yml` still carried the old package
 * name in the row's `name` field after the package was renamed to
 * `dsh-zcode-scribe`, and the loader resolves that field as a module specifier
 * **from the profile directory while applying the tree**. `--dump-config` only
 * *composes* configuration and never applies anything, so it reported a clean
 * tree for a profile that could not start. Measured: a row's resolution state
 * leaves no usable trace in the dump — neither `packageDir` nor
 * `__dshPluginOwner` appears on this harness line whether or not the name
 * resolves.
 *
 * Assertions, all on observable output:
 *   A. `dsh plugin … add` exits 0.
 *   B. In the composed tree, the inserted row's `name` equals this package's
 *      `name`. This is the invariant the whole class of defect violates, and it
 *      is checked here because no cheaper guard looks at it.
 *   C. Booting prints `dsh web: http://…`, **stderr is empty up to that point**,
 *      and the process is still alive once the URL appears. This is the decisive
 *      one: a module that cannot resolve never reaches the URL. Bytes written
 *      after the URL are counted and reported but not asserted on — see the note
 *      above `stderrAtUrl`.
 *
 * ## Which harness gets booted
 *
 * `dsh plugin add` forwards to pnpm, which dsh does not bundle — dsh exits 127
 * with "pnpm was not found" if pnpm is absent (CI installs it).
 *
 * The harness is taken from `node_modules/@deepseek-ai/dsh` when that is a
 * genuine install inside this repository, i.e. the one CI's `npm install
 * --no-save` creates. If instead it resolves **outside** the repository — as it
 * does in a checkout whose `node_modules` is a link to a developer's Electron
 * bundle — it is skipped, because that build is managed by its host application
 * and never prints a listening URL; booting it would report a failure that is
 * not the plugin's. Such a checkout falls through to the `dsh` on PATH.
 *
 * Usage:
 *   node tools/verify-boot.mjs                  # port 31859, 60 s deadline
 *   node tools/verify-boot.mjs --port 0         # let the OS pick, no collisions
 *   node tools/verify-boot.mjs --keep           # keep the throwaway DSH_HOME
 *   node tools/verify-boot.mjs --dsh-bin <path> # a specific dsh entry point
 *
 * Exit codes: 0 pass · 1 the plugin did not install or boot · 2 the environment
 * cannot run this guard (no harness, no pnpm). The distinction matters — "the
 * guard could not run" must never be reported as "the guard passed".
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = 'web'
const WIN = process.platform === 'win32'

// ---------------------------------------------------------------------------
// Arguments and helpers
// ---------------------------------------------------------------------------

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

// The workspace reserves 31850-31859 for this project; 31859 is the port this
// repository's own boot records were taken on.
const PORT = argOf('port', '31859')
const TIMEOUT_MS = Number(argOf('timeout', '60000'))
const KEEP = process.argv.includes('--keep')
const EXPLICIT = argOf('dsh-bin', null)

function fail(message, code = 1) {
  process.stderr.write(`verify-boot: FAIL — ${message}\n`)
  process.exit(code)
}

function note(message) {
  process.stdout.write(`verify-boot: ${message}\n`)
}

// ---------------------------------------------------------------------------
// Locate a harness that behaves like the one CI installs
// ---------------------------------------------------------------------------

/** True when `path` resolves inside the repository (real path, symlinks followed). */
function isInsideRepo(path) {
  let real
  try {
    real = realpathSync(path)
  } catch {
    return false
  }
  const rel = relative(ROOT, real)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

/** The `bin.js` of an install inside this repository, or null (with the reason printed). */
function harnessInRepo() {
  const pkgDir = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = join(pkgDir, 'package.json')
  if (!existsSync(manifest)) return null

  if (!isInsideRepo(pkgDir)) {
    note('node_modules/@deepseek-ai/dsh resolves outside the repository (a link to a bundled harness) — skipping it')
    return null
  }

  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  const bin = parsed.bin
  const rel = typeof bin === 'string' ? bin : bin?.dsh
  const entry = join(pkgDir, rel ?? join('lib', 'bin.js'))
  return existsSync(entry) ? { file: entry, how: 'node_modules' } : null
}

/** An executable `dsh` on PATH, expressed as a spawn command. */
function harnessOnPath() {
  const probe = spawnSync(WIN ? 'dsh.cmd' : 'dsh', ['--version'], { encoding: 'utf8', shell: WIN })
  if (probe.status !== 0) return null
  return { command: WIN ? 'dsh.cmd' : 'dsh', shell: WIN, how: 'PATH' }
}

let HARNESS = null
if (EXPLICIT !== null) {
  const entry = resolve(EXPLICIT)
  if (!existsSync(entry)) fail(`--dsh-bin ${entry} does not exist.`, 2)
  HARNESS = /\.m?js$/.test(entry)
    ? { file: entry, how: '--dsh-bin' }
    : { command: entry, shell: false, how: '--dsh-bin' }
} else {
  HARNESS = harnessInRepo() ?? harnessOnPath()
}
if (HARNESS === null) {
  fail(
    'no usable harness found.\n' +
      '  CI installs one with:\n' +
      '    npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2\n' +
      '  Locally, put an npm-installed `dsh` on PATH, or pass --dsh-bin.',
    2,
  )
}

/** Run the harness with `args`, synchronously. */
function runSync(args, options = {}) {
  if (HARNESS.file !== undefined) {
    return spawnSync(process.execPath, [HARNESS.file, ...args], { encoding: 'utf8', ...options })
  }
  return spawnSync(HARNESS.command, args, { encoding: 'utf8', shell: HARNESS.shell, ...options })
}

/**
 * Spawn the harness with `args`, returning the child.
 *
 * `env` and `cwd` are passed here for the same reason `runSync` passes them, and
 * getting this wrong is how the first draft of this guard became vacuous: with
 * `DSH_HOME` unset the boot silently used the developer's own `~/.dsh` — a
 * profile that starts perfectly well — so the guard reported PASS no matter what
 * the repository did. A guard that can pass while testing nothing is worse than
 * no guard. The mutation test in `docs/TROUBLESHOOTING.md` is what surfaced it.
 */
function runAsync(args) {
  const options = { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }
  if (HARNESS.file !== undefined) return spawn(process.execPath, [HARNESS.file, ...args], options)
  return spawn(HARNESS.command, args, { ...options, shell: HARNESS.shell })
}

const pnpm = spawnSync(WIN ? 'pnpm.cmd' : 'pnpm', ['--version'], { encoding: 'utf8', shell: WIN })
if (pnpm.status !== 0) {
  fail(
    'pnpm is not on PATH, and `dsh plugin add` forwards to it (dsh exits 127 without it).\n' +
      '  Install it first: npm install -g pnpm@12.4.2',
    2,
  )
}

const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

/** The row `id` this repository's patch inserts, read from the patch itself. */
function rowId() {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const insertAt = patch.search(/^-\s*insert\s*:/m)
  if (insertAt === -1) fail('cordis.patch.yml has no `insert:` entry — nothing would be mounted.', 1)
  const match = patch.slice(insertAt).match(/^\s*-\s*id\s*:\s*(\S+)\s*$/m)
  if (match === null) fail('cordis.patch.yml inserts no row with an id — nothing would be mounted.', 1)
  return match[1]
}
const ROW_ID = rowId()

// ---------------------------------------------------------------------------
// A throwaway home, so a failing guard can never damage a real profile
// ---------------------------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), 'dsh-scribe-boot-'))
const ENV = { ...process.env, DSH_HOME: HOME, NO_COLOR: '1', FORCE_COLOR: '0' }

function cleanup() {
  if (KEEP) {
    note(`keeping ${HOME} (--keep)`)
    return
  }
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* a leftover temp directory is not worth failing the guard over */
  }
}

note(`node ${process.versions.node} · pnpm ${String(pnpm.stdout).trim()} · package ${PACKAGE} · row ${ROW_ID}`)
note(`harness ${HARNESS.how}: ${HARNESS.file ?? HARNESS.command}`)
note(`throwaway DSH_HOME ${HOME}`)

// ---------------------------------------------------------------------------
// A. It installs
// ---------------------------------------------------------------------------

const install = runSync(['plugin', '--profile', PROFILE, 'add', ROOT], { cwd: ROOT, env: ENV })
if (install.status !== 0) {
  cleanup()
  process.stderr.write(`${install.stdout ?? ''}${install.stderr ?? ''}`)
  fail(`\`dsh plugin add\` exited ${install.status} — the plugin does not install.`, 1)
}
for (const line of String(install.stdout ?? '').split('\n')) {
  if (line.includes(PACKAGE)) note(`  install → ${line.trim()}`)
}
note('A. install: exit 0')

// ---------------------------------------------------------------------------
// B. The inserted row names this package
// ---------------------------------------------------------------------------

const dump = runSync(['--profile', PROFILE, '--dump-config'], { cwd: ROOT, env: ENV })
if (dump.status !== 0 || String(dump.stderr ?? '').length > 0) {
  cleanup()
  process.stderr.write(`${dump.stdout ?? ''}${dump.stderr ?? ''}`)
  fail('`--dump-config` did not produce a clean tree.', 1)
}
const dumpText = String(dump.stdout ?? '')
const lines = dumpText.split('\n')
const start = lines.indexOf(`- id: ${ROW_ID}`)
if (start === -1) {
  cleanup()
  fail(`the composed tree has no row \`id: ${ROW_ID}\` — cordis.patch.yml was never applied.`, 1)
}
let rowName = null
for (let i = start + 1; i < lines.length && !lines[i].startsWith('- id: '); i += 1) {
  const match = lines[i].match(/^\s+name:\s*(\S+)\s*$/)
  if (match !== null) {
    rowName = match[1]
    break
  }
}
if (rowName !== PACKAGE) {
  cleanup()
  process.stderr.write(`verify-boot: --- row ${ROW_ID} in the composed tree ---\n${lines.slice(start, start + 6).join('\n')}\n`)
  fail(
    `row \`${ROW_ID}\` declares name ${JSON.stringify(rowName)} but the package is ${JSON.stringify(PACKAGE)}.\n` +
      '  The loader resolves that name as a module specifier while applying the tree, so this\n' +
      '  profile would not boot even though the dump above succeeded.',
    1,
  )
}
note(`B. row name: ${ROW_ID} → ${rowName} (matches the package)`)

// ---------------------------------------------------------------------------
// C. It boots — the decisive assertion
// ---------------------------------------------------------------------------

const child = runAsync(['--profile', PROFILE, '--port', PORT, '--no-open'])

let stdout = ''
let stderr = ''
let listeningUrl = null
let exited = null

child.stdout.on('data', (chunk) => {
  stdout += chunk
  if (listeningUrl === null) listeningUrl = stdout.match(/dsh web:\s*(http:\/\/\S+)/)?.[1] ?? null
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.on('exit', (code, signal) => {
  exited = { code, signal }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + TIMEOUT_MS
while (listeningUrl === null && exited === null && Date.now() < deadline) await sleep(100)

/**
 * stderr as it stood at the instant the listening URL appeared.
 *
 * This is what the guard asserts on. Whatever a *shut-down* process writes
 * afterwards is not a boot failure: killing the harness tears down the MCP
 * servers it started, and one of them reporting `BrokenPipeError` on its own
 * stdout is an artefact of the teardown, not of this plugin. The guard shuts the
 * harness down the way `timeout` does (SIGTERM first) to keep even that noise out
 * of the log, and counts bytes on both sides of the line so the difference is
 * visible rather than hidden.
 */
const stderrAtUrl = exited === null && listeningUrl !== null ? stderr : null

/** Shut the child down: SIGTERM, then SIGKILL if it will not go. */
async function stop() {
  if (exited !== null) return
  child.kill('SIGTERM')
  for (let i = 0; i < 50 && exited === null; i += 1) await sleep(100)
  if (exited === null) {
    child.kill('SIGKILL')
    for (let i = 0; i < 30 && exited === null; i += 1) await sleep(100)
  }
}

if (listeningUrl === null || stderrAtUrl === null) {
  const why =
    exited === null ? `timed out after ${TIMEOUT_MS} ms` : `exited with code ${exited.code}, signal ${exited.signal}`
  await stop()
  cleanup()
  process.stderr.write(`verify-boot: --- stdout ---\n${stdout}\nverify-boot: --- stderr ---\n${stderr}\n`)
  fail(`the profile never printed a listening URL (${why}) — the plugin did not boot.`, 1)
}

// Printing a URL is the pass signal, but a process that dies right after
// printing it never served anything, so hold it alive for a beat and re-check.
for (let i = 0; i < 15 && exited === null; i += 1) await sleep(100)
const diedEarly = exited
await stop()

const bytesAtUrl = Buffer.byteLength(stderrAtUrl)
const bytesTotal = Buffer.byteLength(stderr)

note(`C. boot exit      : ${diedEarly === null ? 'still serving when this guard stopped it' : `exited early (code ${diedEarly.code})`}`)
note(`C. listening url  : ${listeningUrl}`)
note(`C. stderr bytes   : ${bytesAtUrl} at the moment the URL appeared · ${bytesTotal} including teardown`)

if (diedEarly !== null) {
  cleanup()
  process.stderr.write(`verify-boot: --- stderr ---\n${stderr}\n`)
  fail(`the process exited (code ${diedEarly.code}) right after printing its URL — it never served.`, 1)
}
if (bytesAtUrl > 0) {
  cleanup()
  process.stderr.write(`verify-boot: --- stderr (up to the URL) ---\n${stderrAtUrl}\n`)
  fail(`the boot wrote to stderr before it finished starting (${bytesAtUrl} bytes).`, 1)
}

if (bytesTotal > bytesAtUrl) note(`C. note: ${bytesTotal - bytesAtUrl} bytes of teardown output after shutdown, ignored by design`)

cleanup()
note('PASS — installs (A) · row name matches the package (B) · boots with empty stderr (C)')
