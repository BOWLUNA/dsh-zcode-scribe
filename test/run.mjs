/**
 * Test entry point — `npm test`.
 *
 * The suites are plain `node:test` files, but the runner is invoked explicitly
 * rather than by letting node discover a directory: on Windows a bare `test`
 * argument resolves as a module path (no extension) and the run dies with
 * MODULE_NOT_FOUND before a single assertion executes. Discovering the files
 * ourselves and passing absolute paths removes that whole class of surprise, and
 * it keeps `npm test` working from any working directory.
 *
 * Exit code is node's own, so CI fails exactly when the suites do.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Every `*.test.mjs` directly under `test/`, sorted so output order is stable. */
export function testFiles(directory = here) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(directory, name))
}

const files = testFiles()

if (files.length === 0) {
  process.stderr.write('no *.test.mjs files found under test/\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
