#!/usr/bin/env node
/**
 * Guard 2 of 3 — the numbers in the documents are claims, so check them.
 *
 * A document saying "100 tests" is a factual assertion about the code, and
 * nothing in the test suite can see it. The reference project found three
 * separate drifts like this in a single review pass. So this guard runs the real
 * thing and compares.
 *
 * What it checks:
 *
 * - **Test counts** — `N tests`, `N suites`, `N/N green`, `N 项测试`, `N 个套件`,
 *   and the TAP summary lines. Every occurrence anywhere in the scanned
 *   documents must match the live run.
 * - **Version** — the `package.json` version appears in both READMEs, SECURITY's
 *   support table, and both changelogs. A release that bumps one of them and not
 *   the others is the cheapest possible bug.
 * - **The declared dsh range** appears verbatim in the READMEs, so the
 *   compatibility claim and the manifest cannot disagree.
 *
 * It deliberately does *not* check prose for truthfulness — only that the numbers
 * a reader will act on are the numbers the code has.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'tools'])

/** Documents a reader will act on. */
function scannedDocuments(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      scannedDocuments(join(directory, entry.name), found)
    } else if (entry.name.endsWith('.md')) {
      // `.zh.md` matches this too — deliberately: a number that drifted only in
      // the Chinese half is exactly the kind of drift this guard exists for.
      found.push(join(directory, entry.name))
    }
  }
  return found
}

/** Run the real suite and read its summary. */
function liveCounts() {
  const result = spawnSync(process.execPath, [join(ROOT, 'test', 'run.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const read = (key) => {
    const match = new RegExp(`^#\\s*${key}\\s+(\\d+)\\s*$`, 'mu').exec(output)
    return match === null ? null : Number(match[1])
  }
  return { tests: read('tests'), suites: read('suites'), pass: read('pass'), fail: read('fail'), status: result.status }
}

const problems = []
const note = (message) => problems.push(message)

const live = liveCounts()
if (live.tests === null || live.suites === null || live.pass === null) {
  note('could not read the live test summary — is `node test/run.mjs` working?')
}
if (live.fail !== null && live.fail !== 0) {
  note(`the live run is not green (fail: ${live.fail}) — fix the tests before trusting any number`)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declaredDsh = pkg.engines?.dsh ?? ''

/**
 * Each entry: a human description, a regex with one or two capture groups, and
 * the value(s) each group must equal.
 */
const numberPatterns = [
  ['"N tests"', /(\d+)\s+tests\b/gi, [live.tests]],
  ['"N suites"', /(\d+)\s+suites\b/gi, [live.suites]],
  ['"N/N green"', /(\d+)\s*\/\s*(\d+)\s+(?:green|passing)\b/gi, [live.pass, live.tests]],
  ['"N 项测试"', /(\d+)\s*项测试/gu, [live.tests]],
  ['"N 个套件"', /(\d+)\s*个套件/gu, [live.suites]],
  ['TAP "# tests N"', /^#\s*tests\s+(\d+)\s*$/gmu, [live.tests]],
  ['TAP "# suites N"', /^#\s*suites\s+(\d+)\s*$/gmu, [live.suites]],
  ['TAP "# pass N"', /^#\s*pass\s+(\d+)\s*$/gmu, [live.pass]],
]

let scanned = 0
let assertions = 0

for (const absolute of scannedDocuments()) {
  const file = relative(ROOT, absolute).split(sep).join('/')
  const text = readFileSync(absolute, 'utf8')
  scanned += 1

  for (const [label, pattern, expected] of numberPatterns) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      for (let group = 1; group < match.length; group += 1) {
        const want = expected[group - 1]
        if (want === null || want === undefined) continue
        assertions += 1
        if (Number(match[group]) !== want) {
          note(`${file}: ${label} says ${match[group]} but the live run says ${want} (near: ${snippet(text, match.index)})`)
        }
      }
    }
  }

  // The package version must be stated wherever a reader looks for it.
  if (['README.md', 'README.zh.md', 'SECURITY.md', 'SECURITY.zh.md', 'CHANGELOG.md', 'CHANGELOG.zh.md'].includes(file)) {
    assertions += 1
    if (!text.includes(pkg.version)) note(`${file}: does not mention the package version ${pkg.version}`)
  }

  // The declared compatibility range must be stated in both READMEs.
  if (['README.md', 'README.zh.md'].includes(file) && declaredDsh !== '') {
    assertions += 1
    if (!text.includes(declaredDsh)) {
      note(`${file}: does not state the declared dsh range ${JSON.stringify(declaredDsh)} from package.json`)
    }
  }
}

function snippet(text, index) {
  const start = Math.max(0, (index ?? 0) - 30)
  return JSON.stringify(text.slice(start, start + 70).replace(/\s+/gu, ' '))
}

// ---------------------------------------------------------------------------

process.stdout.write(`scanned ${scanned} document(s), ${assertions} number assertion(s)\n`)
process.stdout.write(`live: ${live.tests} tests / ${live.suites} suites / ${live.pass} pass / ${live.fail} fail\n`)

if (problems.length > 0) {
  process.stderr.write(`\ndoc numbers FAILED (${problems.length}):\n`)
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.exit(1)
}

process.stdout.write('doc numbers OK\n')
