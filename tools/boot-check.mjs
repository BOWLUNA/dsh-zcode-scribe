#!/usr/bin/env node
/**
 * Boot check — the plugin must install into a real harness and actually serve.
 *
 * Usage:
 *   node tools/boot-check.mjs --port 31859
 *   node tools/boot-check.mjs --port 31859 --dsh-bin <path-to-bin.js>
 *   node tools/boot-check.mjs --port 31859 --keep      # keep the throwaway DSH_HOME
 *
 * Exit codes: 0 pass · 1 an assertion failed (the message names which one) ·
 * 2 the environment cannot run this check at all (no harness, no pnpm). The
 * distinction matters: "the check could not run" must never read as "the plugin
 * is fine".
 *
 * ## Why this exists
 *
 * Every other guard here reads pure logic or composed configuration. Neither
 * applies the plugin, and on 2026-09-21 that gap shipped a 1.0.0 which installed
 * cleanly, passed 101 unit tests, and produced a `--dump-config` tree with
 * `exit 0` and a 0-byte stderr — then took the whole profile down at boot:
 *
 *   Cannot find package 'dsh-scribe' imported from …/profiles/web/
 *
 * One stale word caused it: `cordis.patch.yml` still named the package
 * `dsh-scribe` after the rename to `dsh-zcode-scribe`. The loader resolves that
 * field as a module specifier **from the profile directory while applying the
 * tree**. `--dump-config` only composes configuration and never applies
 * anything, so it cannot be asked this question at all — measured: a row's
 * resolution state leaves no trace in the dump, and the same checkout with the
 * name correct and stale produces byte-identical dumps (`exit 0`, empty stderr,
 * identical `packageDir`/`__dshPluginOwner` absence on dsh 0.1.6-alpha.2).
 *
 * ## The four assertions
 *
 *   A. `dsh plugin --profile web add <repo>` exits 0.
 *   B. Read **the files directly**: the row `name` in `cordis.patch.yml` equals
 *      `package.json`'s `name`. Checked from the files rather than from the dump
 *      because the dump carries no resolution signal to check.
 *   C. Boot `--profile web --port <N> --no-open` and require that **a TCP
 *      connection to that port succeeds** within the timeout. The port, not a
 *      log line: a listening socket is the property that matters, and the
 *      Electron-managed build in a developer's `node_modules` never prints a
 *      listening URL at all, so an assertion on the printed URL reports a
 *      failure that is not the plugin's.
 *   D. stderr is empty **at the moment the port answers**. Bytes written
 *      afterwards are not a boot failure — shutting a harness down tears down
 *      the MCP servers it started, and one of them complaining about its own
 *      broken stdout pipe is an artefact of the teardown. The harness is stopped
 *      with SIGTERM, never SIGKILL, for the same reason.
 *
 * ## Which harness gets checked
 *
 * Discovery order, first hit wins:
 *
 *   1. `--dsh-bin <path>`                       explicit, highest priority
 *   2. `$DSH_INSTALL`                           the supported way to point at a
 *                                               harness somewhere unexpected
 *   3. `<repo>/node_modules/@deepseek-ai/dsh`   the install CI makes
 *   4. `dsh` on PATH                            a machine-level install
 *   5. none of the above ⇒ exit 2, with the exports to copy
 *
 * `DSH_INSTALL` is the harness **install root** (the directory containing
 * `node_modules/@deepseek-ai/…`), e.g. `C:/BL/AI/dsh-harness`; passing the
 * package directory or a `bin.js` works too. There is deliberately **no probe
 * for `%APPDATA%\dsh-desktop`** — that path was deleted on 2026-09-21 and
 * probing it only wastes a stat.
 *
 * `dsh plugin add` forwards to pnpm, which dsh does not bundle (it exits 127
 * with "pnpm was not found" without it). pnpm is therefore a prerequisite, not
 * something this script installs.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = 'web'
const WIN = process.platform === 'win32'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

// The workspace reserves 31850-31859 for this project; 31859 is the port this
// repository's own boot records were taken on.
const PORT = Number(argOf('port', '31859'))
const TIMEOUT_MS = Number(argOf('timeout', '60000'))
const KEEP = process.argv.includes('--keep')
const EXPLICIT = argOf('dsh-bin', null)

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  process.stderr.write(`boot-check: --port must be a TCP port, got ${JSON.stringify(argOf('port', null))}\n`)
  process.exit(2)
}

function note(message) {
  process.stdout.write(`boot-check: ${message}\n`)
}

/** Exit 1 — an assertion failed. */
function fail(which, message) {
  process.stderr.write(`boot-check: FAIL [${which}] ${message}\n`)
  process.exit(1)
}

/** Exit 2 — the environment cannot run this check. */
function refuse(message) {
  process.stderr.write(`boot-check: CANNOT RUN — ${message}\n`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// A throwaway DSH_HOME — asserted before anything else touches the disk
// ---------------------------------------------------------------------------

/**
 * `$DSH_HOME` must be a fresh directory under the system temporary directory,
 * and must not be — nor sit inside — the default one. This is asserted rather
 * than assumed because the first draft of this check spawned the harness without
 * passing `env` at all: `DSH_HOME` was never set, the boot silently used the
 * developer's own `~/.dsh`, and the check reported PASS no matter what the
 * repository did. A vacuous guard is worse than no guard — it converts "nobody
 * checked" into "checked, and it is fine".
 *
 * The two halves are deliberately separate. "Is it temporary?" is what keeps a
 * real profile safe; "is it the default home?" names the specific accident this
 * repository has already had. Note that on Windows the temporary directory lives
 * under the user profile, so "not under the home directory" would reject the
 * correct answer.
 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-boot-check-'))
  const real = realpathSync(home)
  const tempRoot = realpathSync(tmpdir())
  const defaultHome = join(realpathSync(homedir()), '.dsh')

  const discard = (message) => {
    rmSync(real, { recursive: true, force: true })
    refuse(message)
  }
  if (real === defaultHome || real.startsWith(defaultHome + sep)) {
    discard(`refusing to use ${real} as DSH_HOME — it is the default harness home.`)
  }
  if (real !== tempRoot && !real.startsWith(tempRoot + sep)) {
    discard(`refusing to use ${real} as DSH_HOME — it is not under ${tempRoot}.`)
  }
  return real
}

const HOME = makeHome()
const ENV = { ...process.env, DSH_HOME: HOME, NO_COLOR: '1', FORCE_COLOR: '0' }

function cleanup() {
  if (KEEP) {
    note(`keeping ${HOME} (--keep)`)
    return
  }
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* a leftover temp directory is not worth failing the check over */
  }
}

// ---------------------------------------------------------------------------
// Harness discovery — order per the fleet-wide convention
// ---------------------------------------------------------------------------

/** The `bin.js` of a dsh package directory, or null. */
function binOf(pkgDir) {
  const manifest = join(pkgDir, 'package.json')
  if (!existsSync(manifest)) return null
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  if (parsed.name !== '@deepseek-ai/dsh') return null
  const bin = parsed.bin
  const rel = typeof bin === 'string' ? bin : bin?.dsh
  const entry = join(pkgDir, rel ?? join('lib', 'bin.js'))
  return existsSync(entry) ? entry : null
}

/**
 * Candidates for `$DSH_INSTALL`, in the forms people actually set it to: the
 * install root, the package directory, or the entry file itself.
 */
function fromInstallRoot(value) {
  const root = resolve(value)
  const candidates = [
    root,
    join(root, 'node_modules', '@deepseek-ai', 'dsh'),
    join(root, 'dsh'),
  ]
  for (const candidate of candidates) {
    const entry = binOf(candidate)
    if (entry !== null) return { file: entry, how: `DSH_INSTALL (${candidate})` }
  }
  return null
}

function discover() {
  if (EXPLICIT !== null) {
    const entry = resolve(EXPLICIT)
    if (!existsSync(entry)) refuse(`--dsh-bin points at ${entry}, which does not exist.`)
    return /\.m?js$/.test(entry)
      ? { file: entry, how: '--dsh-bin' }
      : { command: entry, shell: false, how: '--dsh-bin' }
  }

  const installed = process.env.DSH_INSTALL
  if (installed !== undefined && installed.length > 0) {
    const found = fromInstallRoot(installed)
    if (found === null) refuse(`DSH_INSTALL=${installed} does not contain an @deepseek-ai/dsh package.`)
    return found
  }

  const inRepo = binOf(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh'))
  if (inRepo !== null) return { file: inRepo, how: 'node_modules' }

  const probe = spawnSync(WIN ? 'dsh.cmd' : 'dsh', ['--version'], { encoding: 'utf8', shell: WIN })
  if (probe.status === 0) return { command: WIN ? 'dsh.cmd' : 'dsh', shell: WIN, how: 'PATH' }

  return null
}

const HARNESS = discover()
if (HARNESS === null) {
  refuse(
    'no harness found. Set one of these up, then re-run:\n' +
      '  # a) point at an existing harness install (the supported way)\n' +
      '  export DSH_INSTALL="C:/BL/AI/dsh-harness"\n' +
      '  # b) or install a harness next to this checkout, the way CI does\n' +
      '  npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2\n' +
      '  # c) or pass --dsh-bin <path-to-@deepseek-ai/dsh/lib/bin.js>',
  )
}

function runSync(args, options = {}) {
  if (HARNESS.file !== undefined) {
    return spawnSync(process.execPath, [HARNESS.file, ...args], { encoding: 'utf8', ...options })
  }
  return spawnSync(HARNESS.command, args, { encoding: 'utf8', shell: HARNESS.shell, ...options })
}

/**
 * pnpm is a prerequisite. Two distinct failures are reported separately, because
 * "not installed" and "installed but unhappy" have different fixes — and an
 * earlier version of this check reported both as "pnpm is not on PATH", which
 * sent one investigation after an PATH problem that did not exist.
 *
 * The probe runs from the system temporary directory rather than from the
 * repository: it is asking whether pnpm exists, not whether this checkout is
 * currently well-formed, and running it in the repository makes a deliberately
 * broken `package.json` (a fixture this project's own mutation tests use) fail
 * the probe for an unrelated reason.
 */
const pnpm = spawnSync(WIN ? 'pnpm.cmd' : 'pnpm', ['--version'], {
  encoding: 'utf8',
  shell: WIN,
  cwd: tmpdir(),
})
if (pnpm.error !== undefined) {
  refuse(
    `pnpm could not be started (${pnpm.error.code ?? pnpm.error.message}).\n` +
      '  `dsh plugin add` forwards to it and dsh does not bundle it — install it first:\n' +
      '    npm install -g pnpm@12',
  )
}
if (pnpm.status !== 0) {
  refuse(
    `pnpm --version exited ${pnpm.status}.\n` +
      `  ${String(pnpm.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}\n` +
      '  This is an environment problem, not a plugin one.',
  )
}

note(`node ${process.versions.node} · pnpm ${String(pnpm.stdout).trim()}`)
note(`harness ${HARNESS.how} → ${HARNESS.file ?? HARNESS.command}`)
note(`throwaway DSH_HOME ${HOME}`)

// ---------------------------------------------------------------------------
// A. It installs
// ---------------------------------------------------------------------------

const install = runSync(['plugin', '--profile', PROFILE, 'add', ROOT], { cwd: ROOT, env: ENV })
if (install.status !== 0) {
  cleanup()
  process.stderr.write(`${install.stdout ?? ''}${install.stderr ?? ''}`)
  fail('A', `\`dsh plugin add\` exited ${install.status} — the plugin does not install.`)
}
note('A. install: exit 0')

// ---------------------------------------------------------------------------
// B. The row names this package — read from the files, not from the dump
// ---------------------------------------------------------------------------

const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const insertAt = patchText.search(/^-[\t ]*insert[\t ]*:/m)
if (insertAt === -1) {
  cleanup()
  fail('B', 'cordis.patch.yml has no `insert:` entry — nothing would be mounted.')
}
const inserted = patchText.slice(insertAt)
const rowId = inserted.match(/^[\t ]*-[\t ]*id[\t ]*:[\t ]*(\S+)[\t ]*$/m)?.[1]
const rowName = inserted.match(/^[\t ]*name[\t ]*:[\t ]*['"]?([^'"\s]+)['"]?[\t ]*$/m)?.[1]
if (rowId === undefined || rowName === undefined) {
  cleanup()
  fail('B', 'cordis.patch.yml inserts no row with both an `id` and a `name`.')
}
if (rowName !== PACKAGE) {
  cleanup()
  fail(
    'B',
    `row \`${rowId}\` declares name ${JSON.stringify(rowName)} but the package is ${JSON.stringify(PACKAGE)}.\n` +
      '  The loader resolves that name as a module specifier while applying the tree, so the\n' +
      '  profile will not boot even though `--dump-config` reports a clean tree.',
  )
}
note(`B. row name: ${rowId} → ${rowName} (matches the package)`)

// ---------------------------------------------------------------------------
// C. It boots and answers on the port
// ---------------------------------------------------------------------------

/** Resolve once something accepts a TCP connection on the port, else null. */
function waitForPort(deadline, child, onExit) {
  return new Promise((done) => {
    const attempt = () => {
      if (onExit.exited !== null) return done('exited')
      if (Date.now() > deadline) return done('timeout')
      const socket = net.connect({ host: '127.0.0.1', port: PORT })
      socket.setTimeout(1000)
      const retry = () => {
        socket.destroy()
        setTimeout(attempt, 100)
      }
      socket.once('connect', () => {
        socket.destroy()
        done('connected')
      })
      socket.once('error', retry)
      socket.once('timeout', retry)
    }
    attempt()
  })
}

const child = (() => {
  const options = { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  if (HARNESS.file !== undefined) return spawn(process.execPath, [HARNESS.file, '--profile', PROFILE, '--port', String(PORT), '--no-open'], options)
  return spawn(HARNESS.command, ['--profile', PROFILE, '--port', String(PORT), '--no-open'], { ...options, shell: HARNESS.shell })
})()

let stdout = ''
let stderr = ''
const onExit = { exited: null }
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.on('exit', (code, signal) => {
  onExit.exited = { code, signal }
})

const outcome = await waitForPort(Date.now() + TIMEOUT_MS, child, onExit)

/** stderr as it stood when the port answered — assertion D is about this value. */
const stderrAtConnect = outcome === 'connected' ? stderr : null

/** Stop the harness: SIGTERM first, SIGKILL only if it will not go. */
async function stop() {
  if (onExit.exited !== null) return
  child.kill('SIGTERM')
  for (let i = 0; i < 50 && onExit.exited === null; i += 1) await new Promise((r) => setTimeout(r, 100))
  if (onExit.exited === null) {
    child.kill('SIGKILL')
    for (let i = 0; i < 30 && onExit.exited === null; i += 1) await new Promise((r) => setTimeout(r, 100))
  }
}

if (outcome !== 'connected') {
  const why =
    onExit.exited === null
      ? `nothing accepted a connection on 127.0.0.1:${PORT} within ${TIMEOUT_MS} ms`
      : `the harness exited with code ${onExit.exited.code}, signal ${onExit.exited.signal}`
  await stop()
  cleanup()
  process.stderr.write(`boot-check: --- stdout ---\n${stdout}\nboot-check: --- stderr ---\n${stderr}\n`)
  fail('C', `${why} — the plugin did not boot.`)
}

// A port that answers and then dies immediately was never serving.
for (let i = 0; i < 15 && onExit.exited === null; i += 1) await new Promise((r) => setTimeout(r, 100))
const diedEarly = onExit.exited
await stop()

const bytesAtConnect = Buffer.byteLength(stderrAtConnect)
const bytesTotal = Buffer.byteLength(stderr)
note(`C. 127.0.0.1:${PORT} answered · ${diedEarly === null ? 'still serving when this check stopped it' : `exited early (code ${diedEarly.code})`}`)
note(`D. stderr bytes: ${bytesAtConnect} at the moment the port answered · ${bytesTotal} including teardown`)

if (diedEarly !== null) {
  cleanup()
  process.stderr.write(`boot-check: --- stderr ---\n${stderr}\n`)
  fail('C', `the harness exited (code ${diedEarly.code}) right after answering — it never served.`)
}
if (bytesAtConnect > 0) {
  cleanup()
  process.stderr.write(`boot-check: --- stderr (up to the first answer) ---\n${stderrAtConnect}\n`)
  fail('D', `the boot wrote to stderr before it finished starting (${bytesAtConnect} bytes).`)
}
if (bytesTotal > bytesAtConnect) {
  note(`note: ${bytesTotal - bytesAtConnect} bytes of teardown output after shutdown, ignored by design`)
}

cleanup()
note('PASS — installs (A) · row name matches the package (B) · boots and answers on the port (C) · clean stderr (D)')
