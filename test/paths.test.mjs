/**
 * Tests for the memory-room path rules.
 *
 * Every refusal reason asserted here is a fixed string on purpose: those exact
 * strings are quoted back to the model and written to the audit log, so a test
 * that only counted failures would let the wording drift.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  SENSITIVE_MEMORY_PATH_SEGMENTS,
  checkMemoryPath,
  checkMemoryPaths,
  isContained,
  isSensitiveSegment,
  memoryFileRelativePath,
  normalizeSensitiveSegment,
} from '../src/paths.mjs'

/** A memory root that exists on whichever platform the suite runs on. */
const ROOT = resolve(process.cwd(), 'test-memory-room')

/** Split a relative path into segments, whatever separator the platform used. */
const segmentsOf = (p) => p.split(/[\\/]+/u).filter((part) => part !== '')

describe('normalizeSensitiveSegment', () => {
  it('strips zero-width and control characters', () => {
    assert.equal(normalizeSensitiveSegment('no\u200bde_modules', { platform: 'linux' }), 'node_modules')
    assert.equal(normalizeSensitiveSegment('\u200e.git', { platform: 'linux' }), '.git')
    assert.equal(normalizeSensitiveSegment('git\u0000', { platform: 'linux' }), 'git')
  })

  it('strips bidirectional overrides, which render a name as its reverse', () => {
    // U+202E makes ".git" display as "tig." and vice versa; stripping it is what
    // keeps the denylist comparison meaningful.
    assert.equal(normalizeSensitiveSegment('.g\u202eit', { platform: 'linux' }), '.git')
    assert.equal(normalizeSensitiveSegment('\u2066.git\u2069', { platform: 'linux' }), '.git')
  })

  it('truncates at the first colon so an NTFS stream cannot hide a reserved name', () => {
    assert.equal(normalizeSensitiveSegment('node_modules:hidden', { platform: 'linux' }), 'node_modules')
    assert.equal(normalizeSensitiveSegment('.git:stream', { platform: 'linux' }), '.git')
  })

  it('drops trailing dots and spaces, which Windows normalises away', () => {
    assert.equal(normalizeSensitiveSegment('node_modules.', { platform: 'linux' }), 'node_modules')
    assert.equal(normalizeSensitiveSegment('.git ', { platform: 'linux' }), '.git')
    assert.equal(normalizeSensitiveSegment('.git. .', { platform: 'linux' }), '.git')
  })

  it('folds case only where the filesystem does', () => {
    assert.equal(normalizeSensitiveSegment('NODE_MODULES', { platform: 'win32' }), 'node_modules')
    assert.equal(normalizeSensitiveSegment('NODE_MODULES', { platform: 'linux' }), 'NODE_MODULES')
  })

  it('leaves an ordinary name alone', () => {
    assert.equal(normalizeSensitiveSegment('auth-refactor.md', { platform: 'linux' }), 'auth-refactor.md')
  })

  it('returns an empty string for input that carries nothing comparable', () => {
    assert.equal(normalizeSensitiveSegment('\u200b\u200b', { platform: 'linux' }), '')
    assert.equal(normalizeSensitiveSegment('.', { platform: 'linux' }), '')
  })

  it('tolerates non-string input instead of throwing', () => {
    assert.equal(normalizeSensitiveSegment(undefined, { platform: 'linux' }), '')
    assert.equal(normalizeSensitiveSegment(42, { platform: 'linux' }), '')
  })
})

describe('isSensitiveSegment', () => {
  it('matches the published list', () => {
    for (const name of ['.git', '.ssh', '.aws', '.gnupg', 'hooks', '.husky', 'node_modules', '.dsh', 'skills']) {
      assert.ok(SENSITIVE_MEMORY_PATH_SEGMENTS.has(name), `${name} should be in the denylist`)
      assert.equal(isSensitiveSegment(name, { platform: 'linux' }), true, `${name} should be refused`)
    }
  })

  it('refuses a segment that normalises down to nothing', () => {
    // Nothing left to compare against means we cannot claim it is safe.
    assert.equal(isSensitiveSegment('\u200b', { platform: 'linux' }), true)
    assert.equal(isSensitiveSegment('.', { platform: 'linux' }), true)
  })

  it('accepts ordinary segments', () => {
    assert.equal(isSensitiveSegment('topics', { platform: 'linux' }), false)
    assert.equal(isSensitiveSegment('user-preferences.md', { platform: 'linux' }), false)
  })

  it('honours a custom denylist', () => {
    const deny = new Set(['secrets'])
    assert.equal(isSensitiveSegment('secrets', { platform: 'linux', deny }), true)
    assert.equal(isSensitiveSegment('.git', { platform: 'linux', deny }), false)
  })
})

describe('isContained', () => {
  it('accepts descendants', () => {
    assert.equal(isContained(ROOT, resolve(ROOT, 'a.md')), true)
    assert.equal(isContained(ROOT, resolve(ROOT, 'deep/nested/a.md')), true)
  })

  it('rejects the root itself, its ancestors, and siblings', () => {
    assert.equal(isContained(ROOT, ROOT), false)
    assert.equal(isContained(ROOT, resolve(ROOT, '..')), false)
    assert.equal(isContained(ROOT, resolve(ROOT, '../sibling/a.md')), false)
    assert.equal(isContained(ROOT, resolve(ROOT, '../../a.md')), false)
  })
})

describe('memoryFileRelativePath', () => {
  it('returns the relative pair for an inside path', () => {
    const result = memoryFileRelativePath(ROOT, 'topics/auth.md')
    assert.ok(result !== null)
    assert.deepEqual(segmentsOf(result.relativePath), ['topics', 'auth.md'])
    assert.equal(result.resolved, resolve(ROOT, 'topics/auth.md'))
  })

  it('returns null for an escaping path rather than throwing', () => {
    assert.equal(memoryFileRelativePath(ROOT, '../outside.md'), null)
    assert.equal(memoryFileRelativePath(ROOT, '../../outside.md'), null)
  })

  it('returns null for unusable input', () => {
    assert.equal(memoryFileRelativePath('', 'a.md'), null)
    assert.equal(memoryFileRelativePath(ROOT, ''), null)
    assert.equal(memoryFileRelativePath(ROOT, undefined), null)
  })

  it('treats an absolute path inside the root as inside', () => {
    const result = memoryFileRelativePath(ROOT, resolve(ROOT, 'a.md'))
    assert.ok(result !== null)
    assert.deepEqual(segmentsOf(result.relativePath), ['a.md'])
  })
})

describe('checkMemoryPath — accepts', () => {
  const accepted = [
    'MEMORY.md',
    'auth-refactor.md',
    'topics/auth.md',
    'deep/nested/topic.md',
    'NOTES.MD', // extensions are case-insensitive on every platform
    'user preferences.md', // spaces are fine; only trailing ones are normalised away
    'a.md',
  ]

  for (const target of accepted) {
    it(`accepts ${JSON.stringify(target)}`, () => {
      const verdict = checkMemoryPath(ROOT, target)
      assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason)
      assert.deepEqual(segmentsOf(verdict.relativePath), segmentsOf(target))
    })
  }
})

describe('checkMemoryPath — refusals', () => {
  const refused = [
    // escaping the room
    ['../outside.md', 'escapes'],
    ['../../outside.md', 'escapes'],
    ['topics/../../outside.md', 'escapes'],
    // reserved segments
    ['.git/config.md', 'reserved'],
    ['.git/hooks/pre-commit.md', 'reserved'],
    ['.ssh/id.md', 'reserved'],
    ['node_modules/pkg/readme.md', 'reserved'],
    ['hooks/notes.md', 'reserved'],
    // Unicode smuggling
    ['.g\u202eit/config.md', 'reserved'],
    ['no\u200bde_modules/x.md', 'reserved'],
    ['.git\u200e/config.md', 'reserved'],
    // trailing-dot smuggling
    ['node_modules./x.md', 'reserved'],
    ['.git /config.md', 'reserved'],
    // NTFS alternate data streams
    ['notes.md:hidden', "cannot contain ':'"],
    ['dir:stream/notes.md', "cannot contain ':'"],
    // wrong extension
    ['notes.txt', 'must end in .md'],
    ['notes', 'must end in .md'],
    ['notes.md.bak', 'must end in .md'],
  ]

  for (const [target, fragment] of refused) {
    it(`refuses ${JSON.stringify(target)}`, () => {
      const verdict = checkMemoryPath(ROOT, target)
      assert.equal(verdict.ok, false, `expected refusal for ${target}`)
      assert.ok(
        verdict.reason.includes(fragment),
        `reason for ${target} should mention ${JSON.stringify(fragment)} but was: ${verdict.reason}`,
      )
    })
  }

  it('refuses the root itself, and says so distinctly from an escape', () => {
    const verdict = checkMemoryPath(ROOT, '.')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /resolves to the memory root itself/)
  })

  it('allows the root when a caller asks for it (listing)', () => {
    const verdict = checkMemoryPath(ROOT, '.', { allowRoot: true })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.relativePath, '')
  })

  it('distinguishes Windows case folding from Linux', () => {
    // On Windows NODE_MODULES *is* node_modules; on Linux it is a different
    // directory that merely looks similar, and refusing it would be a bug.
    assert.equal(checkMemoryPath(ROOT, 'NODE_MODULES/x.md', { platform: 'win32' }).ok, false)
    assert.equal(checkMemoryPath(ROOT, 'NODE_MODULES/x.md', { platform: 'linux' }).ok, true)
  })

  it('applies a caller-supplied denylist instead of the default one', () => {
    const deny = new Set(['drafts'])
    assert.equal(checkMemoryPath(ROOT, 'drafts/a.md', { deny }).ok, false)
    assert.equal(checkMemoryPath(ROOT, '.git/a.md', { deny }).ok, true)
  })

  it('accepts a different required suffix', () => {
    assert.equal(checkMemoryPath(ROOT, 'note.txt', { suffix: '.txt' }).ok, true)
    assert.equal(checkMemoryPath(ROOT, 'note.md', { suffix: '.txt' }).ok, false)
    assert.equal(checkMemoryPath(ROOT, 'anything', { suffix: '' }).ok, true)
  })

  it('returns the offending segment so a caller can name it', () => {
    const verdict = checkMemoryPath(ROOT, 'topics/.git/a.md')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.segment, '.git')
  })
})

describe('checkMemoryPaths — all or nothing', () => {
  it('accepts a clean batch', () => {
    const verdict = checkMemoryPaths(ROOT, ['MEMORY.md', 'topics/a.md'])
    assert.equal(verdict.ok, true)
    assert.equal(verdict.paths.length, 2)
  })

  it('rejects the whole batch when any member is unsafe', () => {
    const verdict = checkMemoryPaths(ROOT, ['MEMORY.md', '.git/config.md', 'topics/a.md'])
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /reserved/)
  })

  it('accepts an empty batch', () => {
    const verdict = checkMemoryPaths(ROOT, [])
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.paths, [])
  })
})
