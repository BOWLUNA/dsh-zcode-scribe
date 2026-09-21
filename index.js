/**
 * dsh-scribe — long-term memory for DeepSeek Harness whose writer is a narrowed
 * subagent.
 *
 * The DSH market lists 190 plugins under `memory`, so this is not a feature
 * gap. It exists for three *safety* properties that none of those 190 provide,
 * each documented against its source in `docs/ARCHITECTURE.md`:
 *
 * 1. **The component that decides what to remember runs with a reduced
 *    capability set.** Not asked to behave — *unable* to misbehave. Network,
 *    shell, MCP, subagent and presentation tools are removed from the writer's
 *    tool list; its remaining writes are confined to one directory by
 *    argument-level guards.
 * 2. **Skip conditions**, so extraction does not run when it cannot produce
 *    anything (the user said nothing substantial; the main agent already wrote
 *    memory this turn).
 * 3. **Path safety on the write path** — a root-relative segment denylist,
 *    Unicode bidi/control stripping, and NTFS alternate-data-stream refusal.
 *
 * Memory is an attack surface. **OWASP ASI06 — Memory & Context Poisoning** is
 * on the Agentic Top 10 for 2026, and legitimate memory writing and malicious
 * memory injection are the *same operation*: same file, same write call. Only
 * intent differs, and intent is not observable. So this plugin does not try to
 * detect intent. It removes capability and constrains what remains.
 *
 * ### What is here today
 *
 * The **read half** (milestone M2): a `scribe_recall` tool the model can call to
 * list what is in the memory room, and the path rules from `src/paths.mjs`
 * deciding which topics it may read. Nothing is written, no subagent is minted,
 * and the injected prompt section is still empty — so mounting this cannot change
 * what the model knows, only what it can ask for.
 *
 * ### Tool naming, and a real collision
 *
 * The tools are prefixed `scribe_` on purpose. `dsh-memento` — the plugin this
 * one is designed to compose with — registers tools named exactly `memory` and
 * `memory_recall`. Tool names are global per host and a duplicate is a **hard
 * boot failure**, not an override. `/memory`-shaped names are therefore taken.
 *
 * ### Deliberately absent
 *
 * No writes, no extraction, no subagent. When the writer arrives it will be
 * created through `ctx.subagents` with `restrict()` and `guard()` attached to
 * *its* `agent.ctx` — never by letting the main agent write memory with its full
 * toolset. If that narrowing seam turns out to be unreachable, extraction does
 * not run at all; see `AGENTS.md` § "The M0 gate".
 *
 * @module dsh-scribe
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { checkMemoryPath } from './src/paths.mjs'

/** Diagnostics name. Distinct from the row id (`scribe`) on purpose: logs get
 * read when several plugins are mounted, and the package name is unambiguous. */
export const name = 'dsh-scribe'

/**
 * Services this row genuinely cannot function without.
 *
 * Both live in `dsh-base`, so every shipped profile has them. Anything *optional*
 * must be reached through a scoped `ctx.inject([...], cb)` instead of being
 * listed here: a row that waits on a service a profile never mounts prints the
 * same `pending` warning a broken installation does, which is how a working
 * plugin gets misreported as a failure.
 */
export const inject = ['tools', 'systemPrompt']

/** The four memory kinds — deliberately the vocabulary Claude Code, ZCode and
 * most of the landscape converged on. An unrecognised value is reported as
 * `unknown` rather than guessed at. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

/** Characters of a topic file a single recall may return, so one call cannot
 * flood the context window. */
export const TOPIC_CHAR_LIMIT = 16_384

/**
 * Row configuration.
 *
 * Every key here must also exist as a key in `cordis.patch.yml`, because a
 * profile patch replaces the whole `config` map and the row is validated against
 * this schema **before** the plugin applies — an undeclared key is a boot
 * failure, not a warning.
 *
 * The defaults are the safe ones. A knob that weakens a property documented in
 * `docs/ARCHITECTURE.md` §4 says so in its own comment, naming what is lost.
 */
export const Config = z.object({
  /** The memory room. Relative paths resolve against the session workspace. */
  dir: z.string().default('.dsh/memory'),

  /**
   * Index cap. Whichever of the two is reached first applies. These are the
   * numbers Claude Code tuned and published, and they are the only
   * empirically-derived pair available.
   */
  indexLineLimit: z.number().default(200),
  indexCharLimit: z.number().default(25000),

  /** Recall manifest: filenames plus their `description`, never file bodies. */
  manifestFileLimit: z.number().default(200),
  manifestPreviewLines: z.number().default(30),

  /** Automatic extraction, performed by the narrowed writer. */
  autoExtract: z.boolean().default(true),

  /** Extraction is a read-decide-write task; a cheap model is the right one. */
  extractorModel: z.string().default('deepseek-v4-flash'),

  /** Ceiling on the writer's own turns, so a confused writer cannot spin. */
  maxWriterTurns: z.number().default(4),

  /**
   * Skip condition 2b: a user turn with fewer words than this cannot carry a
   * memory worth extracting.
   */
  minUserWords: z.number().default(3),

  /**
   * Whether the writer is minted with its capability set narrowed.
   *
   * Turning this **off removes the property this plugin exists to provide**:
   * the writer would keep network, shell, MCP and subagent tools, and every
   * `docs/ARCHITECTURE.md` §4.1 mitigation that depends on reachability would be gone.
   * It is exposed only so the plugin can be inspected at all in a profile where
   * the narrowing seam turns out to be unreachable — and in that case the
   * correct answer is to stop extracting, not to narrow nothing.
   */
  narrowWriter: z.boolean().default(true),

  /**
   * Whether key-shaped material is refused at admission.
   *
   * Memory files are plain files that users put under git. Turning this off
   * means a captured credential can be written to one.
   */
  refuseSecrets: z.boolean().default(true),
})

/** The heading of the injected section. Kept stable so tests can name it. */
export const SECTION_NAME = 'dsh-scribe-memory'

/**
 * The index filename. Not configurable yet: the cap, the manifest exclusion and
 * the guard all key off this one name, and three copies of it that could drift
 * is a worse problem than a missing knob.
 */
export const INDEX_FILENAME = 'MEMORY.md'

/**
 * Resolve the memory room against the session workspace.
 *
 * The session's working directory is the only correct base for a relative `dir`:
 * the same profile serves every project the user opens, and a process-relative
 * base would silently point every project at one shared room.
 *
 * @param {string} dir - the configured room, absolute or workspace-relative.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} [exec] - the tool execution context.
 * @returns {string} an absolute path.
 */
export function resolveMemoryRoot(dir, exec) {
  if (typeof dir === 'string' && /^([A-Za-z]:[\\/]|[\\/])/u.test(dir)) return resolvePath(dir)
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const base = typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : process.cwd()
  return resolvePath(base, dir ?? '.dsh/memory')
}

/** Strip one layer of matching quotes from a frontmatter scalar. */
function stripQuotes(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.endsWith(trimmed[0])
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Read the fields a recall needs out of YAML frontmatter.
 *
 * Deliberately not a YAML parser: this runs on every file in the room and the
 * plugin has no dependencies. Anything unreadable yields empty strings, and a
 * file with broken frontmatter is still listed — losing a description is better
 * than losing the memory.
 *
 * @param {string} text - the file's leading text.
 * @returns {{ description: string, type: string, modified: string }} the fields.
 */
export function parseFrontmatter(text) {
  const empty = { description: '', type: '', modified: '' }
  if (typeof text !== 'string') return empty

  const lines = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
  if ((lines[0] ?? '').trim() !== '---') return empty
  const end = lines.indexOf('---', 1)
  if (end === -1) return empty
  const block = lines.slice(1, end)

  const topLevel = (key) => {
    for (const line of block) {
      const match = new RegExp(`^\\s*${key}\\s*:(.*)$`, 'u').exec(line)
      if (match !== null) return stripQuotes(match[1] ?? '')
    }
    return ''
  }

  // `type` may sit at the top level or nested under `metadata:`; both spellings
  // exist in the wild (ZCode wrote the nested form).
  let type = topLevel('type')
  if (type === '') {
    const index = block.findIndex((line) => /^\s*metadata\s*:/u.test(line))
    if (index !== -1) {
      for (let i = index + 1; i < block.length; i += 1) {
        const line = block[i]
        if (/^\s*\S/u.test(line)) break
        const match = /^\s+type\s*:(.*)$/u.exec(line)
        if (match !== null) {
          type = stripQuotes(match[1] ?? '')
          break
        }
      }
    }
  }

  return {
    description: topLevel('description'),
    type: MEMORY_TYPES.includes(type) ? type : '',
    modified: topLevel('modified'),
  }
}

/**
 * Apply the index cap.
 *
 * The cap is the defence against **memory eviction** — flooding the store so
 * legitimate entries fall out of the loaded window. Two rules matter more than
 * the numbers:
 *
 * - Truncation is **never silent**. The loaded text carries a warning naming the
 *   dimension, the current value and the limit, because an agent that believes
 *   it saved something it did not is worse off than one that knows it was cut.
 * - Lines are cut before characters, and characters are cut at a line boundary,
 *   so the model never receives half a pointer.
 *
 * @param {string} text - the index as stored.
 * @param {number} lineLimit - maximum lines to load.
 * @param {number} charLimit - maximum characters to load.
 * @returns {{ text: string, truncated: boolean, lines: number, chars: number }} the loaded form.
 */
export function applyIndexCap(text, lineLimit, charLimit) {
  const source = typeof text === 'string' ? text : ''
  const allLines = source.split('\n')
  const lineCount = allLines.length

  let loaded = source
  let truncated = false

  if (lineLimit > 0 && lineCount > lineLimit) {
    loaded = allLines.slice(0, lineLimit).join('\n')
    truncated = true
  }
  if (charLimit > 0 && loaded.length > charLimit) {
    const cut = loaded.lastIndexOf('\n', charLimit)
    loaded = loaded.slice(0, cut > 0 ? cut : charLimit)
    truncated = true
  }

  if (truncated) {
    const dimensions = []
    if (lineLimit > 0 && lineCount > lineLimit) dimensions.push(`${lineCount} lines (limit ${lineLimit})`)
    if (charLimit > 0 && source.length > charLimit) {
      dimensions.push(`${source.length} characters (limit ${charLimit})`)
    }
    loaded +=
      `\n\n> WARNING: part of the memory index was NOT loaded — it is ${dimensions.join(' and ')}. ` +
      'Anything past the limit is invisible to you. Keep one line per memory under ~200 characters, ' +
      'move detail into a topic file, and merge or drop stale entries.'
  }

  return { text: loaded, truncated, lines: lineCount, chars: source.length }
}

/**
 * Topic files in the room, newest first, without their bodies.
 *
 * Body-free on purpose: the manifest is what the model reads to decide *whether*
 * to spend a call on a topic, which is the same design Claude Code arrived at.
 */
function readManifest(root, config) {
  let names
  try {
    names = readdirSync(root)
  } catch {
    return [] // a missing room is empty, not an error
  }

  const candidates = []
  for (const entry of names) {
    if (entry.toLowerCase() === INDEX_FILENAME.toLowerCase()) continue
    if (!entry.toLowerCase().endsWith('.md')) continue
    // Every path here goes through the same rule the write path will use — the
    // denylist is about the room's contents, not about who is asking.
    if (!checkMemoryPath(root, entry).ok) continue
    try {
      const stats = statSync(join(root, entry))
      if (stats.isFile()) candidates.push({ entry, mtime: stats.mtimeMs })
    } catch {
      // unreadable right now; skip it rather than failing the whole recall
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime)

  const entries = []
  for (const candidate of candidates.slice(0, Math.max(0, config.manifestFileLimit))) {
    let head = ''
    try {
      head = readFileSync(join(root, candidate.entry), 'utf8')
        .split('\n')
        .slice(0, config.manifestPreviewLines)
        .join('\n')
    } catch {
      head = ''
    }
    const { description, type, modified } = parseFrontmatter(head)
    entries.push({
      file: candidate.entry,
      type: type === '' ? 'unknown' : type,
      description,
      modified: modified === '' ? new Date(candidate.mtime).toISOString() : modified,
    })
  }
  return entries
}

/** One topic body, refused or capped by the path rules. */
function readTopic(root, topic) {
  const verdict = checkMemoryPath(root, topic)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, body: '' }

  if (verdict.relativePath.toLowerCase() === INDEX_FILENAME.toLowerCase()) {
    return {
      ok: false,
      reason: 'the index is already returned in `index`; ask for a topic file instead',
      body: '',
    }
  }

  let source
  try {
    source = readFileSync(verdict.resolved, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read topic ${JSON.stringify(topic)}: ${error?.message ?? String(error)}`,
      body: '',
    }
  }

  if (source.length <= TOPIC_CHAR_LIMIT) return { ok: true, reason: '', body: source }
  const cut = source.lastIndexOf('\n', TOPIC_CHAR_LIMIT)
  return {
    ok: true,
    reason: `topic truncated at ${TOPIC_CHAR_LIMIT} characters of ${source.length}`,
    body: source.slice(0, cut > 0 ? cut : TOPIC_CHAR_LIMIT),
  }
}

/** Human- and model-readable text for a recall result. */
function renderRecall(value) {
  if (value.ok !== true) {
    return `dsh-scribe: recall failed — ${value.message || 'unknown reason'}`
  }

  const lines = [`dsh-scribe memory room: ${value.room}`]
  if (value.hasIndex !== true) {
    lines.push('The index (MEMORY.md) does not exist yet — nothing has been remembered for this workspace.')
  } else {
    lines.push(
      `Index: ${value.indexLines} lines / ${value.indexChars} chars (cap ${value.capLines} / ${value.capChars})` +
        (value.indexTruncated === true ? ' — TRUNCATED; the warning below is part of the data' : ''),
      '',
      value.index,
    )
  }

  const manifest = value.manifest ?? []
  lines.push('', `Topics (${manifest.length}) — bodies are not loaded; ask for one by name:`)
  if (manifest.length === 0) lines.push('- (none)')
  for (const item of manifest) {
    lines.push(`- [${item.type}] ${item.file} (${item.modified}): ${item.description || '(no description)'}`)
  }

  if (value.topic !== '') {
    lines.push('', `Topic ${value.topic}:`)
    if (value.message !== '') lines.push(`(${value.message})`)
    lines.push(value.topicBody)
  }

  return lines.join('\n')
}

/**
 * The read-only tool, as a plain definition.
 *
 * Split out from `recallTool` so the tests can assert this plugin's *intent*
 * without going through the host's `defineTool` wrapper. That matters across the
 * supported range: the schema DSL changed between `0.1.5-rc.2` and
 * `0.1.6-alpha.2`, and the wrapper's own predicates (`isConcurrencySafe`, for one)
 * are not part of the stable contract. Asserting on the wrapped object would make
 * the test's verdict depend on which host version CI happened to install.
 *
 * Read-only and declared concurrency-safe, so several calls in one turn run in
 * parallel without a lock. It never writes, and it never leaves the memory room:
 * `src/paths.mjs` decides which topics exist for it.
 *
 * @param {z.infer<typeof Config>} config - validated row configuration.
 * @returns {object} a `defineTool`-ready definition.
 */
export function recallDefinition(config) {
  return {
    name: 'scribe_recall',
    description:
      'Read the memory room: the index, the list of topic files with their one-line descriptions, and ' +
      'optionally one topic file in full. Use this when the task may depend on something learned in an ' +
      'earlier session — a stated preference, a correction, a project decision. Topic bodies are deliberately ' +
      'not loaded automatically, so read the one you actually need rather than guessing. ' +
      'An empty index means nothing has been remembered yet, which is not an error.',
    parameters: {
      // Optional is expressed by omitting `required`. `0.1.5-rc.2` rejects
      // `required: false` outright ("required must be true when present") with a
      // throw at `defineTool()` time — i.e. a boot failure — and omitting the key
      // is accepted by both lines.
      topic: {
        type: 'string',
        description:
          'A topic filename taken from the manifest, e.g. "project-auth-refactor.md". Omit to receive only the index and the manifest.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          room: { type: 'string' },
          hasIndex: { type: 'boolean' },
          index: { type: 'string' },
          indexTruncated: { type: 'boolean' },
          indexLines: { type: 'integer' },
          indexChars: { type: 'integer' },
          capLines: { type: 'integer' },
          capChars: { type: 'integer' },
          manifest: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                modified: { type: 'string' },
              },
            },
          },
          topic: { type: 'string' },
          topicBody: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
      presentationMeta: (_args, value) => ({
        ok: value.ok === true,
        memories: value.manifest?.length ?? 0,
        truncated: value.indexTruncated === true,
      }),
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const root = resolveMemoryRoot(config.dir, exec)

      let rawIndex = ''
      let hasIndex = false
      try {
        rawIndex = readFileSync(join(root, INDEX_FILENAME), 'utf8')
        hasIndex = true
      } catch {
        hasIndex = false // no index yet is the normal first-run state
      }

      const capped = applyIndexCap(rawIndex, config.indexLineLimit, config.indexCharLimit)

      const value = {
        ok: true,
        room: root,
        hasIndex,
        index: capped.text,
        indexTruncated: capped.truncated,
        indexLines: capped.lines,
        indexChars: capped.chars,
        capLines: config.indexLineLimit,
        capChars: config.indexCharLimit,
        manifest: readManifest(root, config),
        topic: '',
        topicBody: '',
        message: '',
      }

      if (typeof args?.topic === 'string' && args.topic !== '') {
        const topic = readTopic(root, args.topic)
        value.topic = args.topic
        value.topicBody = topic.body
        if (!topic.ok) {
          value.ok = false
          value.message = topic.reason
        } else if (topic.reason !== '') {
          value.message = topic.reason
        }
      }

      return value
    },
  }
}

/**
 * The tool as the host wants it.
 *
 * `defineTool` is not optional: `register()` stores the definition verbatim and
 * validates only `output.schema`, so a raw object would leave the authoring DSL
 * in the payload sent to the provider, which then rejects the whole function
 * schema and names the alphabetically first tool instead of the guilty one.
 *
 * @param {z.infer<typeof Config>} config - validated row configuration.
 * @returns {object} the compiled tool.
 */
export function recallTool(config) {
  return defineTool(recallDefinition(config))
}

/**
 * Mount the capability.
 *
 * Registers the read-only `scribe_recall` tool and contributes an (empty for now)
 * prompt section. It writes nothing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's plugin context.
 * @param {z.infer<typeof Config>} config - validated row configuration.
 */
export function apply(ctx, config) {
  ctx.logger?.info?.(
    `dsh-scribe: mounted — memory room ${JSON.stringify(config.dir)}, ` +
      `index cap ${config.indexLineLimit} lines / ${config.indexCharLimit} chars, ` +
      `extraction ${config.autoExtract ? 'on' : 'off'}`,
  )

  if (!config.narrowWriter) {
    // Loud on purpose. A quiet warning here would let a deployment lose its only
    // security property without anyone noticing.
    ctx.logger?.warn?.(
      'dsh-scribe: narrowWriter is disabled — the extraction writer will NOT have its ' +
        'capability set reduced (no removal of network, shell, MCP or subagent tools). ' +
        'This removes the property this plugin exists to provide; see docs/ARCHITECTURE.md §3.2.',
    )
  }

  // `defineTool` is not optional: `register()` stores the definition verbatim and
  // validates only `output.schema`, so a raw object would leave the authoring DSL
  // in the payload sent to the provider, which then rejects the whole function
  // schema and names the alphabetically first tool instead of the guilty one.
  const tool = recallTool(config)
  ctx.effect(() => ctx.tools.register(tool), 'dsh-scribe: scribe_recall')

  // The read-only half, in its smallest form. Returns '' until an index exists,
  // so mounting this cannot change what the model sees yet.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: -50, // after harness identity (-100), before persona (0)
    text: () => '',
  })
}
