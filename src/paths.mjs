/**
 * dsh-scribe — path safety for the memory room.
 *
 * Every write the scribe performs is checked here first, and every check is
 * evaluated on the path **relative to the memory root** rather than on the
 * absolute path. That is not a stylistic choice: the memory room legitimately
 * lives under a dotted directory (`.dsh/memory`), so an absolute-path denylist
 * would flag the room's own parent.
 *
 * Four normalisations run before any comparison, and each one answers a real
 * attack rather than a hypothetical one:
 *
 * 1. **Unicode control and bidirectional characters are stripped.** A path
 *    containing U+202E (RIGHT-TO-LEFT OVERRIDE) renders in a terminal and in a
 *    diff as its reversed form — `.md` can be made to look like `dm.` and vice
 *    versa. The memory-poisoning literature lists exactly this class under
 *    "hidden payloads: base64 blobs, zero-width Unicode, homoglyph obfuscation".
 * 2. **A segment is truncated at the first `:`** (NTFS alternate data streams).
 *    On Windows, `notes.md:hidden` writes a second, hidden stream onto a file
 *    that passes an extension check on its visible name.
 * 3. **Trailing dots and spaces are removed.** Windows normalises `foo.` to
 *    `foo`, so a denylist that saw `node_modules.` would compare it against a
 *    name the filesystem then treats as `node_modules`.
 * 4. **Case is folded on Windows** for the same reason: `Node_Modules` is the
 *    same directory as `node_modules` there, and not on Linux. Folding is done
 *    only when the target platform is Windows so that a Linux deployment cannot
 *    be tricked by a case variant that would actually be a distinct directory.
 *
 * This module is deliberately pure — `node:path` and nothing else. No filesystem
 * access means every rule below is testable as a table of strings, which is how
 * `test/paths.test.mjs` covers it.
 *
 * @module dsh-scribe/src/paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Path segments that must never appear anywhere inside the memory room.
 *
 * Sections of this list come from three places, and all three matter:
 *
 * - **Security boundaries**: `.git`, `.ssh`, `.aws`, `.gnupg`, `hooks`,
 *   `.githooks`, `.husky`. A memory file that lands in one of these is not a
 *   memory, it is code execution or credential capture.
 * - **Harness-owned directories**: `.dsh`, `.zcode`, `skills`, `commands`,
 *   `agents`. These are read by the platform itself, so a write into them is a
 *   configuration change wearing a memory's clothes.
 * - **Vendor-state directories that are never memory**: `node_modules`,
 *   `.vscode`, `.idea`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`. Cheap to
 *   exclude, awkward to explain if included.
 *
 * A Set, not an array: membership is checked once per path segment per write.
 *
 * @type {ReadonlySet<string>}
 */
export const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  // security boundaries
  '.git',
  'hooks',
  '.husky',
  '.githooks',
  '.ssh',
  '.aws',
  '.gnupg',
  // harness-owned
  '.dsh',
  '.zcode',
  'skills',
  'commands',
  'agents',
  // git internals, reachable if the memory root ever contains a repository
  'head',
  'config',
  'objects',
  'refs',
  // vendor state that is never memory
  'node_modules',
  '.vscode',
  '.idea',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
])

/** Suffixes a memory file is allowed to carry. */
export const MEMORY_FILE_SUFFIX = '.md'

/**
 * Normalise one path segment for comparison against
 * {@link SENSITIVE_MEMORY_PATH_SEGMENTS}.
 *
 * Returns the comparable form; the caller decides whether a match is a denial.
 * An empty result means the segment carried nothing but noise (control
 * characters, a trailing dot) and should be treated as suspicious by the caller
 * rather than as a literal empty name.
 *
 * @param {string} segment - one path component, as it appeared in the request.
 * @param {{ platform?: NodeJS.Platform }} [options] - platform the check runs for.
 * @returns {string} the comparable, folded form of the segment.
 */
export function normalizeSensitiveSegment(segment, options = {}) {
  const platform = options.platform ?? process.platform
  if (typeof segment !== 'string') return ''

  // Strip Unicode control characters, zero-width joiners, and the bidi
  // embedding/override/isolate blocks. The ranges are written out rather than
  // expressed as a property escape because they are load-bearing: U+202E alone
  // reverses how the rest of a line renders.
  const withoutControls = segment.replace(
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu,
    '',
  )

  // Truncate at the first ':' — everything after it is an NTFS alternate data
  // stream, invisible to an extension check.
  const beforeAds = withoutControls.split(':', 1)[0] ?? ''

  // Windows drops trailing dots and spaces when resolving a name; do the same
  // before comparing so a denylisted name cannot hide behind a trailing dot.
  const trimmed = beforeAds.replace(/[. ]+$/u, '')

  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Whether a single segment is denylisted.
 *
 * @param {string} segment - one path component.
 * @param {{ platform?: NodeJS.Platform, deny?: ReadonlySet<string> }} [options] - platform and denylist to use.
 * @returns {boolean} true when the segment must be refused.
 */
export function isSensitiveSegment(segment, options = {}) {
  const deny = options.deny ?? SENSITIVE_MEMORY_PATH_SEGMENTS
  const normalized = normalizeSensitiveSegment(segment, options)
  if (normalized === '') return true // nothing left after normalisation: refuse rather than guess
  return deny.has(normalized)
}

/**
 * Resolve `target` against `root` and report the path relative to the root, or
 * `null` when the target escapes it.
 *
 * Escaping is decided by {@link isContained}, which handles both separators
 * because a Windows process can legitimately receive a POSIX-looking path and
 * vice versa.
 *
 * @param {string} rootDir - absolute memory root.
 * @param {string} target - the path being requested, absolute or root-relative.
 * @returns {{ resolved: string, relativePath: string } | null} the resolved pair, or null when outside.
 */
export function memoryFileRelativePath(rootDir, target) {
  if (typeof rootDir !== 'string' || rootDir === '') return null
  if (typeof target !== 'string' || target === '') return null

  const root = resolve(rootDir)
  const resolved = resolve(root, target)
  if (!isContained(root, resolved)) return null

  const rel = relative(root, resolved)
  return { resolved, relativePath: rel }
}

/**
 * Whether `resolved` sits strictly inside `rootDir`.
 *
 * Strictly: the root itself is not a writable memory file. Equality is excluded
 * because every caller is resolving a *file* under the room.
 *
 * @param {string} rootDir - absolute root.
 * @param {string} resolved - absolute candidate.
 * @returns {boolean} true when the candidate is inside and not equal to the root.
 */
export function isContained(rootDir, resolved) {
  const rel = relative(resolve(rootDir), resolve(resolved))
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith('../') &&
    !rel.startsWith('..\\') &&
    !isAbsolute(rel)
  )
}

/**
 * Check one requested memory path in full and explain a refusal.
 *
 * The reasons are fixed strings on purpose: they are asserted by tests, quoted
 * back to the model verbatim, and logged. A reason that varies per call cannot
 * be relied on by any of those three.
 *
 * @param {string} rootDir - absolute memory root.
 * @param {string} target - the requested path.
 * @param {{ platform?: NodeJS.Platform, deny?: ReadonlySet<string>, suffix?: string, allowRoot?: boolean }} [options]
 *   - `platform` selects Windows case folding; `deny` replaces the default
 *   denylist; `suffix` is the required extension (default `.md`); `allowRoot`
 *   permits the room itself (used when listing, never when writing).
 * @returns {{ ok: true, resolved: string, relativePath: string }
 *   | { ok: false, reason: string, segment?: string }} the verdict.
 */
export function checkMemoryPath(rootDir, target, options = {}) {
  const root = resolve(rootDir ?? '')
  const resolved = resolve(root, target ?? '')

  if (!isContained(root, resolved)) {
    // Distinguish the two refusals because they mean different things to a user:
    // "you pointed outside the room" is an escape attempt, "you pointed at the
    // room" is a caller mistake.
    if (resolved === root) {
      return options.allowRoot === true
        ? { ok: true, resolved, relativePath: '' }
        : { ok: false, reason: `path resolves to the memory root itself: ${resolved}` }
    }
    return {
      ok: false,
      reason: `path escapes the memory root: ${target}`,
    }
  }

  const rel = relative(root, resolved)
  const segments = rel.split(/[\\/]+/u).filter((part) => part !== '')

  for (const segment of segments) {
    // A literal ':' is refused outright rather than merely normalised away. It
    // has no legitimate use in a memory filename, and on Windows it opens an
    // NTFS alternate data stream — a second, hidden body of content attached to
    // a file whose visible name and extension both pass every other check. The
    // truncation in normalizeSensitiveSegment() stays because it keeps the
    // denylist honest if some earlier layer already accepted such a path.
    if (segment.includes(':')) {
      return {
        ok: false,
        reason: `path segments cannot contain ':': ${JSON.stringify(segment)}`,
        segment,
      }
    }
    if (isSensitiveSegment(segment, options)) {
      return {
        ok: false,
        reason: `path segment is reserved and cannot appear inside the memory room: ${JSON.stringify(segment)}`,
        segment,
      }
    }
  }

  const suffix = options.suffix ?? MEMORY_FILE_SUFFIX
  const last = segments[segments.length - 1] ?? ''
  // Extensions are compared case-insensitively on every platform, independently
  // of the denylist's platform-dependent folding: `NOTES.MD` is meant to be a
  // memory file, whereas `NODE_MODULES` is only the denylisted directory on the
  // platform where the filesystem agrees.
  if (suffix !== '' && !last.toLowerCase().endsWith(suffix)) {
    return {
      ok: false,
      reason: `memory files must end in ${suffix}: ${JSON.stringify(last)}`,
      segment: last,
    }
  }

  return { ok: true, resolved, relativePath: rel }
}

/**
 * Refuse a whole batch, reporting the first failure.
 *
 * Batch-shaped because the guard sees one call at a time but a caller (the
 * admission step) often validates a candidate set together; a partial accept
 * would leave half a memory written.
 *
 * @param {string} rootDir - absolute memory root.
 * @param {readonly string[]} targets - requested paths.
 * @param {Parameters<typeof checkMemoryPath>[2]} [options] - same options.
 * @returns {{ ok: true, paths: Array<{ resolved: string, relativePath: string }> }
 *   | { ok: false, reason: string, segment?: string }} all-or-nothing verdict.
 */
export function checkMemoryPaths(rootDir, targets, options = {}) {
  const accepted = []
  for (const target of targets) {
    const verdict = checkMemoryPath(rootDir, target, options)
    if (!verdict.ok) return verdict
    accepted.push({ resolved: verdict.resolved, relativePath: verdict.relativePath })
  }
  return { ok: true, paths: accepted }
}
