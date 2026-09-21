/**
 * What `apply()` actually does when a live host calls it.
 *
 * The boot smoke proves the row *loads*; it does not prove the plugin did
 * anything after loading. Those are different claims, and this workspace has
 * already been burned by the gap between them — a row that resolves in
 * `--dump-config` (exit 0, stderr 0 bytes) can still fail the entire profile
 * boot at `apply()` time, and a row that boots can still register nothing at
 * all.
 *
 * So the plugin is imported as the host imports it — the real `index.js`, not a
 * reimplementation — and handed a recording context. Everything asserted here is
 * a fact the host would observe.
 *
 * No harness is started, no model is called, nothing is written to disk.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, SECTION_NAME, apply, inject, name } from '../index.js'

/**
 * The smallest context that is still honest about what the plugin uses.
 *
 * Members are recorded rather than stubbed away, because for this plugin "it
 * called the right seam with the right arguments" *is* the behaviour under test.
 */
function recordingContext() {
  const sections = []
  const tools = []
  const effects = []
  const logs = { info: [], warn: [] }
  return {
    sections,
    tools,
    effects,
    logs,
    ctx: {
      logger: {
        info: (message) => logs.info.push(String(message)),
        warn: (message) => logs.warn.push(String(message)),
      },
      systemPrompt: {
        section: (definition) => {
          sections.push(definition)
          return () => {}
        },
      },
      tools: {
        register: (definition) => {
          tools.push(definition)
          return () => {}
        },
      },
      effect: (callback) => {
        // Cordis runs an effect body immediately and keeps the returned
        // disposer; recording without invoking would hide every registration
        // that happens inside one.
        const dispose = callback()
        effects.push(callback)
        return typeof dispose === 'function' ? dispose : () => {}
      },
    },
  }
}

/** Apply the plugin with parsed-or-defaulted config, the way a row would. */
function applyWith(overrides = {}) {
  const recorder = recordingContext()
  apply(recorder.ctx, Config(overrides))
  return recorder
}

describe('row identity', () => {
  it('exports the name, inject list and apply function the loader needs', () => {
    assert.equal(name, 'dsh-scribe')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
    assert.equal(typeof apply, 'function')
  })

  it('declares no service a shipped profile lacks', () => {
    // `tools` and `systemPrompt` both come from dsh-base, so every shipped
    // profile mounts them. A row that waits on anything else prints the same
    // `pending` warning a broken installation does.
    for (const service of inject) {
      assert.ok(['tools', 'systemPrompt'].includes(service), `unexpected hard dependency: ${service}`)
    }
  })
})

describe('config defaults are the safe ones', () => {
  it('narrows the writer, refuses secrets, and caps the index', () => {
    const config = Config({})
    assert.equal(config.narrowWriter, true)
    assert.equal(config.refuseSecrets, true)
    assert.equal(config.autoExtract, true)
    assert.equal(config.indexLineLimit, 200)
    assert.equal(config.indexCharLimit, 25000)
  })

  it('defaults the memory room to a workspace-relative path', () => {
    assert.equal(Config({}).dir, '.dsh/memory')
  })

  it('rejects a wrong-typed value instead of coercing it', () => {
    assert.throws(() => Config({ indexLineLimit: 'two hundred' }))
  })
})

describe('apply()', () => {
  it('registers exactly one prompt section, named and ordered as documented', () => {
    const { sections } = applyWith()
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, SECTION_NAME)
    // After harness identity (-100), before persona (0).
    assert.equal(sections[0].order, -50)
  })

  it('contributes no prompt text yet, so mounting cannot change what the model sees', () => {
    const { sections } = applyWith()
    assert.equal(typeof sections[0].text, 'function')
    assert.equal(sections[0].text(), '')
  })

  it('registers exactly one tool, and it is the read-only one', () => {
    const { tools } = applyWith()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'scribe_recall')
  })

  it('never claims a tool name that dsh-memento already owns', () => {
    // `dsh-memento` registers `memory` and `memory_recall`, and it is the plugin
    // this one is documented to compose with. Tool names are global per host and
    // a duplicate is a hard boot failure, not an override — so this is the
    // regression guard for a real, reachable outage.
    const taken = new Set(['memory', 'memory_recall'])
    for (const tool of applyWith().tools) {
      assert.ok(!taken.has(tool.name), `tool name collides with dsh-memento: ${tool.name}`)
    }
  })

  it('ties both registrations to the plugin lifecycle', () => {
    // `ctx.effect` is how they are disposed with the row. Registering outside it
    // leaks across a hot reload, which is what `patchReload: live` does on every
    // patch edit.
    const { effects } = applyWith()
    assert.equal(effects.length, 1)
    assert.equal(typeof effects[0], 'function')
  })

  it('registers through a single effect, and the effect registered exactly one tool', () => {
    const { effects, tools } = applyWith()
    assert.equal(effects.length, 1, 'one lifecycle-scoped effect')
    assert.equal(tools.length, 1, 'and it registered one tool, not two')
    // Disposal is idempotent from the host's point of view.
    assert.equal(typeof effects[0](), 'function')
  })

  it('logs one line naming the live configuration', () => {
    const { logs } = applyWith({ dir: '.dsh/memory', indexLineLimit: 200 })
    assert.equal(logs.info.length, 1)
    assert.match(logs.info[0], /dsh-scribe: mounted/)
    assert.match(logs.info[0], /\.dsh\/memory/)
  })

  it('warns loudly when the security property is switched off', () => {
    const { logs } = applyWith({ narrowWriter: false })
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /narrowWriter is disabled/)
    assert.match(logs.warn[0], /network, shell, MCP or subagent/)
  })

  it('stays quiet when the writer is narrowed', () => {
    assert.deepEqual(applyWith({ narrowWriter: true }).logs.warn, [])
  })

  it('survives a context with no logger mounted', () => {
    const sections = []
    assert.doesNotThrow(() =>
      apply(
        {
          systemPrompt: { section: (definition) => sections.push(definition) },
          tools: { register: () => () => {} },
          effect: (callback) => callback(),
        },
        Config({}),
      ),
    )
    assert.equal(sections.length, 1)
  })
})
