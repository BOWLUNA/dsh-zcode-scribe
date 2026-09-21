/**
 * The read half: index capping, frontmatter reading, and the tool's behaviour
 * against a real memory room on disk.
 *
 * The `execute()` cases below build an actual directory tree in the OS temp
 * directory and call the tool the way the host calls it. That is deliberate —
 * the interesting failures here are filesystem ones (a missing room, a topic
 * that escapes it, an unreadable file), and a mocked filesystem would test the
 * mock.
 *
 * `defineTool` wraps `execute` so it always returns a Promise, whatever the
 * implementation does — hence the `await`s.
 *
 * Nothing outside the temp directory is read or written.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  Config,
  INDEX_FILENAME,
  TOPIC_CHAR_LIMIT,
  applyIndexCap,
  parseFrontmatter,
  recallDefinition,
  recallTool,
  resolveMemoryRoot,
} from '../index.js'

/** Temp roots created by this suite, removed in one sweep at the end. */
const created = []
function tempRoom() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scribe-recall-'))
  created.push(dir)
  return dir
}
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** The execution context shape a tool receives; only `cwd` matters here. */
const execIn = (cwd) => ({ agent: { session: { header: { cwd } } } })

/** Render a value exactly as the host would, for assertions on the model's view. */
function rendered(value) {
  return recallTool(Config({}))
    .output.render({}, value)
    .map((part) => part.text)
    .join('\n')
}

describe('resolveMemoryRoot', () => {
  it('passes an absolute configured room straight through', () => {
    const absolute = resolve('C:/somewhere/memory')
    assert.equal(resolveMemoryRoot(absolute, execIn('C:/elsewhere')), absolute)
  })

  it('resolves a relative room against the session workspace, not the process', () => {
    const cwd = resolve('C:/projects/alpha')
    assert.equal(resolveMemoryRoot('.dsh/memory', execIn(cwd)), join(cwd, '.dsh', 'memory'))
  })

  it('falls back to the process directory when the session has no cwd', () => {
    assert.equal(resolveMemoryRoot('.dsh/memory', {}), join(process.cwd(), '.dsh', 'memory'))
    assert.equal(resolveMemoryRoot('.dsh/memory', undefined), join(process.cwd(), '.dsh', 'memory'))
  })

  it('lets a relative room climb out, because resolve() is the authority', () => {
    const cwd = resolve('C:/projects/alpha')
    assert.equal(resolveMemoryRoot('../shared', execIn(cwd)), join(resolve('C:/projects'), 'shared'))
  })
})

describe('parseFrontmatter', () => {
  it('reads description, type and modified', () => {
    const parsed = parseFrontmatter('---\ndescription: JWT migration\nmodified: 2026-09-21T08:12:00Z\n---\nbody')
    assert.equal(parsed.description, 'JWT migration')
    assert.equal(parsed.modified, '2026-09-21T08:12:00Z')
    assert.equal(parsed.type, '')
  })

  it('reads a nested metadata.type, the spelling ZCode wrote', () => {
    const parsed = parseFrontmatter('---\ndescription: x\nmetadata:\n  type: project\n---\nbody')
    assert.equal(parsed.type, 'project')
  })

  it('prefers a top-level type over a nested one', () => {
    assert.equal(parseFrontmatter('---\ntype: feedback\nmetadata:\n  type: project\n---\n').type, 'feedback')
  })

  it('reports an unknown type as empty rather than guessing', () => {
    assert.equal(parseFrontmatter('---\ntype: nonsense\n---\n').type, '')
  })

  it('tolerates a BOM and CRLF endings', () => {
    assert.equal(parseFrontmatter('\uFEFF---\r\ndescription: windows\r\n---\r\nbody').description, 'windows')
  })

  it('strips one layer of matching quotes', () => {
    assert.equal(parseFrontmatter('---\ndescription: "quoted: value"\n---\n').description, 'quoted: value')
  })

  it('returns empty fields for missing or unterminated frontmatter', () => {
    for (const text of ['', 'no frontmatter here', '---\ndescription: x\n', '---\n', 'not a string']) {
      assert.deepEqual(
        parseFrontmatter(text),
        { description: '', type: '', modified: '' },
        `input: ${JSON.stringify(text)}`,
      )
    }
  })
})

describe('applyIndexCap', () => {
  const caps = (text, lines = 200, chars = 25000) => applyIndexCap(text, lines, chars)

  it('leaves a small index untouched and untruncated', () => {
    const result = caps('- one\n- two')
    assert.equal(result.truncated, false)
    assert.equal(result.text, '- one\n- two')
    assert.equal(result.lines, 2)
  })

  it('cuts at the line limit and says so, naming lines', () => {
    const result = caps(Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n'), 3, 25000)
    assert.equal(result.truncated, true)
    assert.ok(result.text.startsWith('line 0\nline 1\nline 2'))
    assert.match(result.text, /WARNING: part of the memory index was NOT loaded/)
    assert.match(result.text, /5 lines \(limit 3\)/)
  })

  it('cuts at the character limit on a line boundary', () => {
    const result = caps('aaaa\nbbbb\ncccc\ndddd', 200, 12)
    assert.equal(result.truncated, true)
    // 12 lands inside "cccc"; the cut goes back to the preceding newline.
    assert.ok(result.text.startsWith('aaaa\nbbbb'))
    assert.ok(!result.text.includes('cc'))
    assert.match(result.text, /characters \(limit 12\)/)
  })

  it('names both dimensions when both are exceeded', () => {
    const result = caps(Array.from({ length: 10 }, () => 'x'.repeat(20)).join('\n'), 3, 10)
    assert.match(result.text, /lines \(limit 3\)/)
    assert.match(result.text, /characters \(limit 10\)/)
  })

  it('never truncates silently — a warning always accompanies a cut', () => {
    for (const [text, lines, chars] of [['a\nb\nc', 1, 999], ['aaaaaaaaaa', 999, 2]]) {
      const result = caps(text, lines, chars)
      assert.equal(result.truncated, true)
      assert.match(result.text, /WARNING/)
      assert.match(result.text, /invisible to you/)
    }
  })

  it('treats a non-positive limit as unlimited', () => {
    assert.equal(caps('a\nb\nc\n', 0, 0).truncated, false)
  })

  it('reports the stored size, not the loaded size', () => {
    const result = caps('aaaa\nbbbb\ncccc', 1, 25000)
    assert.equal(result.lines, 3)
    assert.equal(result.chars, 14)
  })
})

describe('scribe_recall definition', () => {
  // Assertions about this plugin's *intent* are made against the plain
  // definition, not the wrapped tool: the host's `defineTool` is not a stable
  // contract across 0.1.5-rc.2 and 0.1.6-alpha.2 (the schema DSL changed, and so
  // did the shape of the wrapper's own predicates). Asserting on the wrapper
  // would make the verdict depend on which host version CI installed.
  const definition = recallDefinition(Config({}))
  const compiled = recallTool(Config({}))

  it('is named and described for the model', () => {
    assert.equal(definition.name, 'scribe_recall')
    assert.ok(definition.description.length > 80)
  })

  it('declares an optional topic parameter', () => {
    assert.deepEqual(Object.keys(definition.parameters), ['topic'])
    // Optionality is the *absence* of `required`: 0.1.5-rc.2 rejects
    // `required: false` with "required must be true when present", and that
    // rejection happens at defineTool() time — i.e. during boot.
    assert.equal('required' in definition.parameters.topic, false)
  })

  it('declares the full output contract the host validates', () => {
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(definition.output.schema.additionalProperties, false)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.presentationMeta, 'function')
  })

  it('declares itself concurrency safe, because it only reads', () => {
    assert.equal(definition.isConcurrencySafe(), true)
  })

  it('compiles through defineTool, which the host requires', () => {
    // Registering the raw definition would ship the authoring DSL to the
    // provider, which rejects the whole function schema.
    assert.equal(compiled.name, 'scribe_recall')
    assert.equal(typeof compiled.execute, 'function')
    assert.equal(typeof compiled.isConcurrencySafe, 'function')
    assert.equal(typeof compiled.isConcurrencySafe({}), 'boolean')
  })
})

describe('scribe_recall execute()', () => {
  const call = async (room, topic, configOverrides = {}) => {
    const tool = recallTool(Config({ dir: room, ...configOverrides }))
    return tool.execute(topic === undefined ? {} : { topic }, execIn(room))
  }

  it('reports an empty room without failing', async () => {
    const room = join(tempRoom(), 'memory')
    const value = await call(room)

    assert.equal(value.ok, true)
    assert.equal(value.hasIndex, false)
    assert.deepEqual(value.manifest, [])
    assert.match(rendered(value), /does not exist yet/)
  })

  it('returns the index and a description-only manifest', async () => {
    const room = tempRoom()
    writeFileSync(join(room, INDEX_FILENAME), '- [project] alpha.md: first\n- [user] beta.md: second\n')
    writeFileSync(join(room, 'alpha.md'), '---\ndescription: The alpha decision\nmetadata:\n  type: project\n---\nbody A')
    writeFileSync(join(room, 'beta.md'), '---\ndescription: prefers pnpm\ntype: user\n---\nbody B')
    writeFileSync(join(room, 'notes.txt'), 'not markdown')
    writeFileSync(join(room, 'no-frontmatter.md'), 'just a body')

    const value = await call(room)
    assert.equal(value.hasIndex, true)
    assert.match(value.index, /alpha\.md/)
    assert.equal(value.manifest.length, 3, 'txt files are not memory')

    const byFile = Object.fromEntries(value.manifest.map((item) => [item.file, item]))
    assert.equal(byFile['alpha.md'].type, 'project')
    assert.equal(byFile['alpha.md'].description, 'The alpha decision')
    assert.equal(byFile['beta.md'].type, 'user')
    assert.equal(byFile['no-frontmatter.md'].type, 'unknown')
    assert.equal(byFile['no-frontmatter.md'].description, '')
    // Bodies are never inlined into the manifest.
    assert.ok(!JSON.stringify(value.manifest).includes('body A'))
    assert.ok(!Number.isNaN(Date.parse(byFile['no-frontmatter.md'].modified)))
  })

  it('reads a named topic body', async () => {
    const room = tempRoom()
    writeFileSync(join(room, 'alpha.md'), '---\ndescription: A\n---\nthe alpha body')
    const value = await call(room, 'alpha.md')

    assert.equal(value.ok, true)
    // The whole file comes back, frontmatter included: it is lossless, and the
    // metadata is cheap compared with the body the model actually asked for.
    assert.match(value.topicBody, /the alpha body/)
    assert.match(value.topicBody, /description: A/)
    assert.match(rendered(value), /Topic alpha\.md:/)
  })

  it('refuses a topic that escapes the room, and names the reason', async () => {
    const value = await call(tempRoom(), '../../outside.md')

    assert.equal(value.ok, false)
    assert.match(value.message, /escapes the memory root/)
    assert.equal(value.topicBody, '')
  })

  it('refuses a reserved topic segment', async () => {
    const value = await call(tempRoom(), '.git/config.md')
    assert.equal(value.ok, false)
    assert.match(value.message, /reserved/)
  })

  it('refuses a non-markdown topic', async () => {
    assert.equal((await call(tempRoom(), 'secrets.txt')).ok, false)
  })

  it('points at the index field instead of re-reading MEMORY.md as a topic', async () => {
    const room = tempRoom()
    writeFileSync(join(room, INDEX_FILENAME), '- entry\n')
    const value = await call(room, INDEX_FILENAME)

    assert.equal(value.ok, false)
    assert.match(value.message, /already returned in `index`/)
  })

  it('caps a topic body and says it was capped', async () => {
    const room = tempRoom()
    writeFileSync(join(room, 'big.md'), `${'x'.repeat(TOPIC_CHAR_LIMIT + 500)}\n`)
    const value = await call(room, 'big.md')

    assert.equal(value.ok, true)
    assert.match(value.message, /topic truncated at/)
    assert.ok(value.topicBody.length <= TOPIC_CHAR_LIMIT)
  })

  it('truncates an oversized index and carries the warning into the value', async () => {
    const room = tempRoom()
    writeFileSync(join(room, INDEX_FILENAME), Array.from({ length: 300 }, (_, i) => `- line ${i}`).join('\n'))
    const value = await call(room)

    assert.equal(value.indexTruncated, true)
    assert.equal(value.indexLines, 300)
    assert.equal(value.capLines, 200)
    assert.match(value.index, /WARNING/)
  })

  it('honours a raised cap from configuration', async () => {
    const room = tempRoom()
    writeFileSync(join(room, INDEX_FILENAME), Array.from({ length: 300 }, (_, i) => `- line ${i}`).join('\n'))
    const value = await call(room, undefined, { indexLineLimit: 400 })

    assert.equal(value.indexTruncated, false)
    assert.match(value.index, /- line 299/)
  })

  it('never lets a reserved directory contribute a memory', async () => {
    const room = tempRoom()
    mkdirSync(join(room, '.git'), { recursive: true })
    writeFileSync(join(room, '.git', 'config.md'), '---\ndescription: ssh config\n---\n')
    writeFileSync(join(room, 'real.md'), '---\ndescription: real\n---\n')

    const value = await call(room)
    assert.deepEqual(
      value.manifest.map((item) => item.file),
      ['real.md'],
    )
  })
})
