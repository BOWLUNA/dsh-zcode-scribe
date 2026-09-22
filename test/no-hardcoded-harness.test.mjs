/**
 * The harness is found, never hardcoded.
 *
 * On 2026-09-21 the desktop harness was relocated and the previous install root
 * and its data directory were deleted. Every literal in this repository went
 * stale at the same moment — including the rescue message in `install.sh`, which
 * is the only guidance a user sees when an install fails, and which was pointing
 * at two directories that no longer existed.
 *
 * The fix was to resolve the harness in one documented order and to keep exactly
 * one resolver. This suite is what stops the literals from growing back: the
 * failure mode is silent (a stale path only shows up when someone else runs the
 * script, on a machine where it no longer exists), so a rule in a document is
 * not enough.
 *
 * These are file-content assertions on purpose. They need no harness, no pnpm
 * and no network, so they run in the fast guard and fail in a second rather than
 * in a boot check five minutes later.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Directories that are never part of the repository's own text. */
const SKIP = new Set(['.git', 'node_modules', '.dsh-dev'])

/** Every regular file in the working tree, excluding vendor and VCS directories. */
function walk(directory = ROOT) {
  const found = []
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

const FILES = walk().map((path) => ({ path, rel: relative(ROOT, path).split('\\').join('/') }))

/**
 * A harness install root on *this* machine. Deliberately narrow: `%APPDATA%` and
 * `DSH Desktop` appear in comments that warn against probing them, and that is
 * the point of those comments — what must never come back is a literal that the
 * code would actually use.
 */
const MACHINE_HARNESS = /C:[\\/]BL[\\/]AI[\\/]/i

describe('no hardcoded harness path', () => {
  it('the repository text contains no machine-specific harness root', () => {
    const offenders = []
    for (const { path, rel } of FILES) {
      // Binary-ish files are not text and cannot carry a path we care about.
      if (/\.(tgz|tar|gz|zstd|png|jpg|ico)$/i.test(rel)) continue
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      text.split('\n').forEach((line, index) => {
        if (MACHINE_HARNESS.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(
      offenders,
      [],
      `a harness install root is hardcoded again — resolve it via DSH_INSTALL instead:\n${offenders.join('\n')}`,
    )
  })

  it('tools/resolve-dsh.sh resolves through DSH_INSTALL', () => {
    const text = readFileSync(join(ROOT, 'tools', 'resolve-dsh.sh'), 'utf8')
    assert.match(text, /DSH_INSTALL/, 'the shared resolver no longer reads DSH_INSTALL')
    assert.match(
      text,
      /while|for root in "\$\{DSH_INSTALL/,
      'the resolver is supposed to try DSH_INSTALL first',
    )
  })

  it('tools/boot-check.mjs documents the four-place discovery order', () => {
    const text = readFileSync(join(ROOT, 'tools', 'boot-check.mjs'), 'utf8')
    for (const needle of ['--dsh-bin', 'DSH_INSTALL', 'node_modules/@deepseek-ai', 'PATH']) {
      assert.ok(
        text.includes(needle),
        `tools/boot-check.mjs does not mention ${needle} — the discovery order is the contract`,
      )
    }
  })
})
