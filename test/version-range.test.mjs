/**
 * The version guard must not lie.
 *
 * `tools/verify-version-consistency.mjs` decides whether a given dsh version
 * falls inside the range this package declares, and its answer gates CI. It
 * implements semver evaluation itself — the package has no dependencies — and
 * the rule most hand-rolled checkers omit is the one that matters here:
 *
 *   **a prerelease version only satisfies a comparator set if some comparator on
 *   the same `major.minor.patch` tuple also carries a prerelease.**
 *
 * Omit it and the evaluator is *looser than npm*: it reports ✓ for versions npm
 * would refuse. That is not a cosmetic difference — a peer range that npm rejects
 * is a bundle import failure, which is a boot failure, and a guard that says ✓
 * about it protects nothing. The same defect was found and fixed once already in
 * this project family (dsh-custom-mode, commit 7a76920: "it compared
 * component-wise without node-semver's prerelease gate ⇒ looser than npm ⇒ CI had
 * been protected by a guard that lied").
 *
 * So this suite pins the evaluator from both directions:
 *
 *   1. **A hand-written table** whose expectations were produced by real
 *      `node-semver`, not by reading our own code. Each case carries the reason
 *      it is interesting.
 *   2. **A differential test against `node-semver` itself**, when it is
 *      resolvable. It is skipped, loudly, when it is not — the package ships no
 *      dependencies and a clean clone has no `node_modules`, so the table is the
 *      floor and the differential run is the ceiling.
 *
 * The negative cases are the point. A table of cases that all pass would be
 * satisfied by an evaluator that always returns true.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { satisfies } from '../tools/verify-version-consistency.mjs'

/** What this repository actually declares, kept here so a range edit trips this suite. */
const DECLARED = '>=0.1.5-rc.2 <0.2.0 || >=0.1.6-alpha.1 <0.2.0'

describe('semver range evaluation (the prerelease gate)', () => {
  // Expectations below were read off real node-semver. The `why` is the part that
  // makes a failure diagnosable without re-deriving semver from memory.
  const TABLE = [
    // --- the prerelease gate: these are the ones a naive evaluator gets wrong ---
    { v: '0.1.7-alpha.2', r: DECLARED, want: false, why: 'no comparator names the 0.1.7 tuple with a prerelease ⇒ npm refuses it' },
    { v: '0.1.7-alpha.1', r: DECLARED, want: false, why: 'same gate, one alpha earlier' },
    { v: '0.1.6-alpha.2', r: '^0.1.5-rc.2', want: false, why: 'the caret upper bound is 0.2.0-0, whose tuple is 0.2.0 — so the 0.1.6 prerelease is excluded' },
    { v: '0.1.6-alpha.2', r: '>=0.1.5-rc.2 <0.2.0', want: false, why: 'the upper comparator names 0.2.0 with no prerelease ⇒ a 0.1.6 prerelease matches nothing' },
    { v: '0.1.6-alpha.2', r: DECLARED, want: true, why: 'the second union member names 0.1.6-alpha.1 with a prerelease ⇒ same tuple ⇒ allowed' },
    { v: '0.1.5-rc.3', r: '>=0.1.5-rc.2 <0.2.0', want: true, why: 'a prerelease of the *same* tuple as the lower bound, which carries one' },

    // --- releases, where the gate must not interfere ---
    { v: '0.1.5', r: DECLARED, want: true, why: 'a release inside the first member' },
    { v: '0.1.8', r: DECLARED, want: true, why: 'a later release, still below 0.2.0' },
    { v: '0.2.0', r: DECLARED, want: false, why: 'the exclusive upper bound itself' },
    { v: '0.2.0-0', r: DECLARED, want: false, why: 'a prerelease of the upper bound: not below it, and the gate also refuses it' },
    { v: '0.1.4', r: DECLARED, want: false, why: 'below the lower bound' },

    // --- the shapes the guard itself feeds in ---
    { v: '0.1.5-rc.2', r: DECLARED, want: true, why: 'a CI matrix entry' },
    { v: '0.1.5-rc.2', r: '0.1.5-rc.2', want: true, why: 'an exact pin' },
    { v: '0.1.5-rc.3', r: '0.1.5-rc.2', want: false, why: 'an exact pin is exact' },
    { v: '0.1.5', r: '0.1.5-rc.2', want: false, why: 'the release outranks its own prerelease' },
    { v: '0.1.7-alpha.2', r: '>=0.1.7-alpha.1 <0.2.0-0', want: true, why: 'the range an adapter would declare for the 0.1.7 line' },
    { v: '0.2.0-0', r: '>=0.1.7-alpha.1 <0.2.0-0', want: false, why: 'the `-0` upper bound exists precisely to exclude this' },

    // --- forms the evaluator must accept rather than choke on ---
    { v: '0.1.5', r: '*', want: true, why: 'a wildcard admits every release' },
    { v: '0.1.5-rc.2', r: '*', want: false, why: 'the gate applies to `*` too — it expands to no comparators, so no tuple can carry a prerelease. Found by the differential test below' },
    { v: '0.1.5', r: '0.1', want: true, why: 'a partial version means >=0.1.0 <0.2.0' },
    { v: '0.2.0', r: '0.1', want: false, why: 'the partial-version upper bound is exclusive' },
    { v: '0.1.6-alpha.2', r: '~0.1.5-rc.2', want: false, why: 'tilde upper bound is 0.2.0-0, so the 0.1.6 prerelease is gated out' },
    { v: '0.1.5-rc.3', r: '~0.1.5-rc.2', want: true, why: 'same tuple as the tilde base, which carries a prerelease' },
  ]

  for (const { v, r, want, why } of TABLE) {
    it(`${v} ${want ? 'satisfies' : 'does NOT satisfy'} ${JSON.stringify(r)} — ${why}`, () => {
      assert.equal(satisfies(v, r), want)
    })
  }

  it('the declared range is exactly the one this table was written against', () => {
    const pkg = createRequire(import.meta.url)('../package.json')
    assert.equal(
      pkg.engines.dsh,
      DECLARED,
      'engines.dsh changed — every expectation above was derived from the old range, so re-derive them',
    )
  })

  it('a version that cannot be parsed throws rather than guessing', () => {
    assert.throws(() => satisfies('not-a-version', DECLARED))
    assert.throws(() => satisfies('0.1.5', 'not-a-range'))
  })
})

describe('differential: this evaluator vs node-semver', () => {
  const require = createRequire(import.meta.url)
  let semver = null
  try {
    semver = require('semver')
  } catch {
    try {
      // The harness install carries it; that is how the expectations above were made.
      semver = require('@deepseek-ai/dsh/node_modules/semver')
    } catch {
      semver = null
    }
  }

  const RANGES = [
    DECLARED,
    '>=0.1.5-rc.2 <0.2.0',
    '>=0.1.7-alpha.1 <0.2.0-0',
    '^0.1.5-rc.2',
    '~0.1.5-rc.2',
    '*',
    '0.1',
    '0.1.5-rc.2',
  ]
  const VERSIONS = [
    '0.1.4', '0.1.5-rc.2', '0.1.5-rc.3', '0.1.5',
    '0.1.6-alpha.1', '0.1.6-alpha.2',
    '0.1.7-alpha.1', '0.1.7-alpha.2',
    '0.1.8', '0.2.0-0', '0.2.0',
  ]

  it('agrees with node-semver on every (range, version) pair', (t) => {
    if (semver === null) {
      t.skip('node-semver is not resolvable here (no node_modules) — the table above is the floor')
      return
    }
    const mismatches = []
    for (const range of RANGES) {
      for (const version of VERSIONS) {
        const expected = semver.satisfies(version, range)
        const actual = satisfies(version, range)
        if (expected !== actual) mismatches.push(`${version} vs ${JSON.stringify(range)}: node-semver=${expected}, ours=${actual}`)
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `the evaluator disagrees with node-semver — a guard that is looser than npm protects nothing:\n${mismatches.join('\n')}`,
    )
  })
})
