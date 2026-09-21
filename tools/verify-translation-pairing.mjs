#!/usr/bin/env node
/**
 * Guard 1 of 3 — bilingual pairing.
 *
 * Every user-facing document exists twice, and the two copies are the same
 * document. This guard enforces three things and nothing else:
 *
 * 1. **Pairs exist.** A declared base document without its `.zh.md` fails, and so
 *    does a stray `.zh.md` whose base is missing. One-way drift is the failure
 *    mode: the Chinese half gets updated, the English half does not, and only a
 *    reader of the other language finds out.
 * 2. **The recorded hashes still match.** Each pair has an `.i18n.yaml` holding
 *    the git blob hash of both sides *as of the last time someone confirmed they
 *    agree*. Editing one side without re-recording means the file claims an
 *    agreement that no longer holds.
 * 3. **Language purity.** A Chinese document is written in Chinese; an English
 *    one is not quietly half-translated. Long stretches of English prose inside a
 *    `.zh.md` are the usual shape of a bad merge.
 *
 * Recording is deliberately separate from checking: `--write` says "the two sides
 * agree now"; a plain run says "and nothing has changed since". That is why the
 * workflow is *edit both → re-record → re-check*, in that order. Running `--write`
 * on its own is a no-op that looks like success, which is exactly how the
 * reference project turned four CI matrices red once.
 *
 * Usage:
 *   node tools/verify-translation-pairing.mjs          # check
 *   node tools/verify-translation-pairing.mjs --write  # record, then report
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRITE = process.argv.includes('--write')

/** Directories that are never part of the repo's document set. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'dist', 'coverage'])

/**
 * Documents that must be paired, because a user of either language reads them.
 *
 * Listed explicitly rather than inferred, because "a pair exists" is only half the
 * requirement — the other half is that the *right* documents are paired. A README
 * with no Chinese translation is a missing pair, not an absent pair.
 */
const REQUIRED_BASES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'test/README.md',
]

/**
 * Documents that are English-only **by declared policy**, with the reason.
 *
 * This is a policy list, not an exemption list: every entry is printed on every
 * run, pass or fail, so the gap stays visible rather than becoming a fact nobody
 * remembers deciding. A file that should be paired and is not must never end up
 * here without a reason a reviewer can argue with.
 */
const ENGLISH_ONLY = new Map([
  [
    'AGENTS.md',
    'the machine-facing contract for coding agents; the reference project keeps it English-only too',
  ],
  [
    'docs/ARCHITECTURE.md',
    'design documents in this family are canonical in English; the Chinese side is tracked as a known gap, see the record',
  ],
  [
    'docs/MEASUREMENTS.md',
    'raw command output is language-neutral; translating it would risk transcribing a number differently',
  ],
  [
    'docs/PUBLISHING.md',
    'release procedure, read while running commands; the commands are the content',
  ],
  [
    'docs/TROUBLESHOOTING.md',
    'error strings quoted from the tools are English; a translation would have to reproduce them verbatim anyway',
  ],
])

/** Files the pairing guard has decided are unpaired, and why. */
const pairingExempt = (path) => ENGLISH_ONLY.get(path)

/** Code fences, inline code, and link targets are not prose. */
function stripNonProse(text) {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/^\s{4,}\S.*$/gmu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\]\([^)]*\)/gu, ']')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu

/** Ratio of CJK characters to all non-whitespace characters. */
function cjkRatio(text) {
  const prose = stripNonProse(text).replace(/\s+/gu, '')
  if (prose.length === 0) return 0
  let cjk = 0
  for (const match of prose.matchAll(CJK)) cjk += match[0].length
  return cjk / prose.length
}

/** A path relative to the repo root, always with forward slashes. */
function repoPath(absolute) {
  return relative(ROOT, absolute).split(sep).join('/')
}

/** Every `*.zh.md` under the repo, relative to the root. */
function discoverChineseFiles(directory = ROOT, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      discoverChineseFiles(join(directory, entry.name), found)
    } else if (entry.name.endsWith('.zh.md')) {
      found.push(repoPath(join(directory, entry.name)))
    }
  }
  return found
}

/** The git blob hash of a byte buffer — the same value `git hash-object` prints. */
function gitBlobHash(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`, 'utf8').update(buffer).digest('hex')
}

/** The `.i18n.yaml` path that records a given base document's pair. */
const manifestFor = (base) => `${base.slice(0, -'.md'.length)}.i18n.yaml`

/** Minimal reader for the flat `path: hash` shape this guard writes. */
function readManifest(text) {
  const entries = new Map()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const index = line.indexOf(':')
    if (index === -1) continue
    entries.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  return entries
}

function renderManifest(base, hashes) {
  return [
    '# 双语配对一致性记录：两侧在「上次确认一致」时的 git blob 哈希。',
    '# 两份文档权威相同——改完任意一侧，请把另一侧也改掉，然后重新记录：',
    '#   node tools/verify-translation-pairing.mjs --write',
    ...hashes.map(([file, hash]) => `${file}: ${hash}`),
    '',
  ].join('\n')
}

const problems = []
const note = (message) => problems.push(message)

/** Every pair the guard will look at, whether declared or discovered. */
const chineseFiles = discoverChineseFiles()
const declared = new Set([...REQUIRED_BASES, ...chineseFiles.map((p) => p.slice(0, -'.zh.md'.length) + '.md')])

let checked = 0
let recorded = 0

for (const base of [...declared].sort()) {
  const zh = `${base.slice(0, -'.md'.length)}.zh.md`
  const baseAbsolute = join(ROOT, base)
  const zhAbsolute = join(ROOT, zh)

  const exemption = pairingExempt(base)
  if (exemption !== undefined) {
    if (exists(zhAbsolute)) note(`${zh} exists but ${base} is declared English-only (${exemption}) — remove one side or pair them`)
    continue
  }

  if (!exists(baseAbsolute)) {
    note(`missing ${base} (declared or referenced by ${zh})`)
    continue
  }
  if (!exists(zhAbsolute)) {
    note(`missing ${zh} — every declared document needs a Chinese half`)
    continue
  }

  const baseBytes = readFileSync(baseAbsolute)
  const zhBytes = readFileSync(zhAbsolute)
  checked += 1

  // 3) language purity
  const baseText = baseBytes.toString('utf8')
  const zhText = zhBytes.toString('utf8')
  if (baseText.length > 800 && cjkRatio(baseText) > 0.02) {
    note(`${base}: looks like a translated file (CJK ratio ${(cjkRatio(baseText) * 100).toFixed(1)}%) — the English side must be English`)
  }
  if (zhText.length > 800 && cjkRatio(zhText) < 0.10) {
    note(`${zh}: too little Chinese (CJK ratio ${(cjkRatio(zhText) * 100).toFixed(1)}%) — the Chinese side must be Chinese`)
  }

  // 2) recorded hashes
  const manifestPath = join(ROOT, manifestFor(base))
  const hashes = [
    [base, gitBlobHash(baseBytes)],
    [zh, gitBlobHash(zhBytes)],
  ]

  if (WRITE) {
    writeFileSync(manifestPath, renderManifest(base, hashes), 'utf8')
    recorded += 1
    continue
  }

  if (!exists(manifestPath)) {
    note(`missing ${manifestFor(base)} — run with --write to record the pair`)
    continue
  }
  const recordedHashes = readManifest(readFileSync(manifestPath, 'utf8'))
  for (const [file, hash] of hashes) {
    const previous = recordedHashes.get(file)
    if (previous === undefined) note(`${manifestFor(base)} has no entry for ${file}`)
    else if (previous !== hash) {
      note(`${file} changed since the pair was last confirmed — edit both sides, then re-record`)
    }
  }
}

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

// The declared English-only documents must at least exist: a policy entry for a
// file that was deleted or renamed quietly stops describing anything.
for (const [path, reason] of ENGLISH_ONLY) {
  if (!exists(join(ROOT, path))) {
    note(`${path} is declared English-only ("${reason}") but does not exist — remove the stale policy entry`)
  }
}

if (WRITE) {
  process.stdout.write(`recorded ${recorded} pair(s), ${checked} checked\n`)
} else {
  process.stdout.write(`checked ${checked} pair(s)\n`)
}

if (ENGLISH_ONLY.size > 0) {
  process.stdout.write(`\nEnglish-only by declared policy (${ENGLISH_ONLY.size}) — the gap, stated rather than assumed:\n`)
  for (const [path, reason] of ENGLISH_ONLY) process.stdout.write(`  - ${path}: ${reason}\n`)
}

if (problems.length > 0) {
  process.stderr.write(`\ntranslation pairing FAILED (${problems.length}):\n`)
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.exit(1)
}

process.stdout.write('\ntranslation pairing OK\n')
