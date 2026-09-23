#!/usr/bin/env node
/**
 * Guard 3 of 3 — the declared compatibility must be true, and CI must be testing
 * inside it.
 *
 * A `peerDependencies` range that nothing satisfies is not a warning, it is a
 * **boot failure**: a bundle whose import cannot resolve takes the whole profile
 * down. And a CI matrix pinned outside `engines.dsh` is worse than no CI, because
 * it reports green about a configuration the package does not claim to support.
 *
 * `--dsh <version>` is **required**. Without it the guard has nothing to assert
 * against and exits 1 rather than guessing — the reference project's version of
 * this script inferred the version from its workflow file until the workflow
 * switched to a matrix variable, at which point a bare run became a permanent
 * failure that looked like a real regression.
 *
 * The semver evaluation is implemented here rather than imported, for two
 * reasons: the package has no dependencies, and the rule that actually bites is
 * the one most hand-rolled checkers omit — **a prerelease version only satisfies
 * a comparator set if some comparator on the same `major.minor.patch` tuple also
 * carries a prerelease**. That is why `^0.1.5-rc.2` never matches
 * `0.1.6-alpha.2`, and why the ranges in this repository spell out each line.
 *
 * Usage:
 *   node tools/verify-version-consistency.mjs --dsh 0.1.5-rc.2
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// A small semver range evaluator (comparators, unions, caret, tilde)
// ---------------------------------------------------------------------------

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a version string, or return null. */
function parseVersion(text) {
  const match = VERSION.exec(String(text).trim())
  if (match === null) return null
  return {
    raw: String(text).trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

const tupleOf = (v) => `${v.major}.${v.minor}.${v.patch}`

/** -1 / 0 / 1, per the semver precedence rules. */
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A version WITH a prerelease has lower precedence than the release itself.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNumeric) {
      return -1 // numeric identifiers always have lower precedence
    } else if (rightNumeric) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/** Expand one `||`-separated group into a list of comparators. */
function expandGroup(group) {
  const text = group.trim()
  if (text === '' || text === '*' || text === 'x') return []

  if (text.startsWith('^')) {
    const base = parseVersion(text.slice(1))
    if (base === null) throw new Error(`unparseable caret range: ${text}`)
    // The upper bound carries `-0` so that a prerelease of the boundary release
    // is excluded, which is what node-semver does.
    const upper =
      base.major > 0
        ? `${base.major + 1}.0.0-0`
        : base.minor > 0
          ? `0.${base.minor + 1}.0-0`
          : `0.0.${base.patch + 1}-0`
    return [
      { op: '>=', version: base },
      { op: '<', version: parseVersion(upper) },
    ]
  }

  if (text.startsWith('~')) {
    const base = parseVersion(text.slice(1))
    if (base === null) throw new Error(`unparseable tilde range: ${text}`)
    return [
      { op: '>=', version: base },
      { op: '<', version: parseVersion(`${base.major}.${base.minor + 1}.0-0`) },
    ]
  }

  const tokens = text.split(/\s+/u).filter((token) => token !== '')
  const comparators = []
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(token)
    const op = match[1] ?? '='
    // A partial version such as `0.1` means `>=0.1.0 <0.2.0`.
    const parts = match[2].split('-')[0].split('.')
    if (parts.length < 3 && op === '=') {
      const padded = [parts[0], parts[1] ?? '0', '0'].join('.')
      comparators.push({ op: '>=', version: parseVersion(padded) })
      comparators.push({
        op: '<',
        version: parseVersion(`${parts[0]}.${Number(parts[1] ?? 0) + 1}.0-0`),
      })
      continue
    }
    const version = parseVersion(match[2])
    if (version === null) throw new Error(`unparseable comparator: ${token}`)
    comparators.push({ op, version })
  }
  return comparators
}

/** Split a range into its `||` groups of comparators. */
function parseRange(range) {
  return String(range)
    .split('||')
    .map(expandGroup)
}

/** Whether one comparator holds for a version. */
function comparatorHolds(version, comparator) {  const order = compare(version, comparator.version)
  switch (comparator.op) {
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    case '<':
      return order < 0
    case '=':
      return order === 0
    default:
      throw new Error(`unknown comparator operator: ${comparator.op}`)
  }
}

/**
 * Whether a version satisfies a range.
 *
 * The prerelease gate is the point of this function: a prerelease version may
 * only satisfy a group when one of that group's comparators names the same
 * `major.minor.patch` tuple *and* itself carries a prerelease.
 *
 * The gate applies to `*` too, and that is not obvious: `*` expands to no
 * comparators at all, so there is no tuple to match and a prerelease matches
 * nothing. node-semver agrees — `satisfies('0.1.5-rc.2', '*')` is `false` by
 * default. Returning `true` there (the first version of this function did) makes
 * the evaluator looser than npm, which is the exact defect this file exists to
 * avoid. `test/version-range.test.mjs` cross-checks against node-semver and
 * caught it.
 */
export function satisfies(text, range) {
  const version = parseVersion(text)
  if (version === null) throw new Error(`unparseable version: ${text}`)
  const groups = parseRange(range)

  for (const group of groups) {
    if (group.length === 0) {
      // A wildcard group: any release matches; a prerelease needs an explicit
      // same-tuple prerelease comparator, and there is none to be found here.
      if (version.prerelease.length === 0) return true
      continue
    }
    if (!group.every((comparator) => comparatorHolds(version, comparator))) continue

    if (version.prerelease.length > 0) {
      const sameTuple = group.some(
        (comparator) =>
          tupleOf(comparator.version) === tupleOf(version) && comparator.version.prerelease.length > 0,
      )
      if (!sameTuple) continue
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The CLI. Kept behind `isEntryPoint` so the range evaluator above can be
// imported by the test suite: a module that does its work at import time cannot
// be tested, and an untested semver evaluator is exactly the kind of guard that
// reports ✓ for the wrong reason. `test/version-range.test.mjs` imports
// `satisfies` and cross-checks it against node-semver.
// ---------------------------------------------------------------------------

/** The value after `--name`, or null. */
function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

function main() {
  const problems = []
  const note = (message) => problems.push(message)

  const target = argument('--dsh')
  if (target === null) {
    process.stderr.write(
      'verify-version-consistency: --dsh <version> is required.\n' +
        '  The guard asserts that a *given* dsh version falls inside the range this package declares.\n' +
        '  CI passes the matrix entry: --dsh ${{ matrix.dsh }}\n' +
        '  Locally: node tools/verify-version-consistency.mjs --dsh 0.1.5-rc.2\n',
    )
    return 1
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  // The published artifact must carry a bare x.y.z, or markets will not auto-install it.
  if (!/^\d+\.\d+\.\d+$/u.test(pkg.version)) {
    note(`package.json version ${JSON.stringify(pkg.version)} is not a bare x.y.z — markets auto-install only that shape`)
  }

  // 1) the requested version must be inside engines.dsh
  const enginesDsh = pkg.engines?.dsh
  if (typeof enginesDsh !== 'string' || enginesDsh === '') {
    note('package.json declares no engines.dsh — the compatibility claim is missing')
  } else if (!satisfies(target, enginesDsh)) {
    note(`dsh ${target} does NOT satisfy engines.dsh ${JSON.stringify(enginesDsh)}`)
  }

  // 2) Peers whose version line **tracks dsh** must accept the dsh version too — an
  //    unsatisfiable peer is a bundle import failure, i.e. a boot failure, not a
  //    warning.
  //
  //    Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` are compared. The other host
  //    packages have independent version lines (`schemastery` is 3.x, `cordis` is
  //    4.x), and asserting that "dsh 0.1.5-rc.2" satisfies "^3.18.2" is a category
  //    error that makes the guard report a problem no change could fix. This library
  //    does not know a peer's line from its name in general, so the rule is stated
  //    rather than inferred.
  const tracksDsh = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

  const peers = pkg.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (!tracksDsh(name)) continue
    try {
      if (!satisfies(target, range)) {
        note(`dsh ${target} does NOT satisfy the ${name} peer range ${JSON.stringify(range)}`)
      }
    } catch (error) {
      note(`${name}: ${error.message}`)
    }
  }

  // 3) everything CI tests must also be inside the declared range
  let workflow = null
  try {
    workflow = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8')
  } catch {
    note('.github/workflows/test.yml is missing — there is no CI to keep in step with engines.dsh')
  }

  const matrixMatch = workflow === null ? null : /dsh:\s*\[([^\]]*)\]/u.exec(workflow)
  if (matrixMatch === null) {
    note('.github/workflows/test.yml has no `dsh: [...]` matrix — CI is not pinned to a dsh version')
  } else {
    const pinned = [...matrixMatch[1].matchAll(/'([^']+)'|"([^"]+)"|([0-9][^\s,]*)/gu)].map(
      (match) => match[1] ?? match[2] ?? match[3],
    )
    if (pinned.length === 0) note('.github/workflows/test.yml has an empty dsh matrix')
    for (const version of pinned) {
      if (enginesDsh !== undefined && !satisfies(version, enginesDsh)) {
        note(`CI pins dsh ${version}, which is outside the declared engines.dsh ${JSON.stringify(enginesDsh)} — CI would test an unsupported configuration`)
      }
    }
    if (pinned.length > 0 && !pinned.includes(target)) {
      note(`--dsh ${target} is not one of the versions CI tests (${pinned.join(', ')})`)
    }
  }

  process.stdout.write(`package ${pkg.name}@${pkg.version} · engines.dsh ${JSON.stringify(enginesDsh ?? null)} · asserted against ${target}\n`)

  if (problems.length > 0) {
    process.stderr.write(`\nversion consistency FAILED (${problems.length}):\n`)
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    return 1
  }

  process.stdout.write('version consistency OK\n')
  return 0
}

/** Whether this file was invoked as a program rather than imported. */
function isEntryPoint() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return resolve(invoked) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exit(main())
