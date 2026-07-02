#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Checks changed primary-language source files against the project style gates.

import { execFileSync, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

let checkAll = false
let fix = false

for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case '--all':
      checkAll = true
      break
    case '--fix':
      fix = true
      break
    case '-h':
    case '--help':
      process.stdout.write(
        [
          'Usage: node scripts/checkStyle.mjs [--all] [--fix]',
          '  no flags : check files changed from STYLE_BASE_REF or HEAD',
          '  --all    : check all tracked primary-language source files',
          '  --fix    : rewrite checked files with their language formatter',
          '',
        ].join('\n'),
      )
      process.exit(0)
      break
    default:
      process.stderr.write(`Unknown style option: ${arg}\n`)
      process.exit(2)
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

function listCandidateFiles() {
  if (checkAll) return git(['ls-files'])
  const baseRef = process.env.STYLE_BASE_REF
  if (baseRef) return git(['diff', '--name-only', '--diff-filter=ACMRT', `${baseRef}...HEAD`])
  const combined = [
    ...git(['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD']),
    ...git(['diff', '--name-only', '--diff-filter=ACMRT', '--cached']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]
  return [...new Set(combined)].sort()
}

const EXCLUDED_SEGMENTS = /(^|\/)(node_modules|dist|build|coverage)\//
const EXCLUDED_FILES = new Set(['packages/engine/src/embedded.ts', 'apps/runtime/src/runtime/version.gen.ts'])
const TS_PATTERNS = [
  /^apps\/.+\.(ts|tsx|js|mjs|cjs)$/,
  /^packages\/.+\.(ts|tsx|js|mjs|cjs)$/,
  /^tests\/typescript\/.+\.(ts|tsx)$/,
  /^scripts\/.+\.(ts|js|mjs|cjs)$/,
  /^examples\/.+\.(js|mjs|cjs)$/,
]
const PY_PATTERNS = [/^packages\/.+\.py$/, /^tests\/python\/.+\.py$/, /^tests\/shared\/test-utils\/python\/.+\.py$/, /^examples\/.+\.py$/]

const tsFiles = []
const goFiles = []
const pyFiles = []

for (const file of listCandidateFiles()) {
  try {
    if (!statSync(file).isFile()) continue
  } catch {
    continue
  }
  if (EXCLUDED_SEGMENTS.test(file) || EXCLUDED_FILES.has(file)) continue
  if (TS_PATTERNS.some((pattern) => pattern.test(file))) tsFiles.push(file)
  if (file.endsWith('.go')) goFiles.push(file)
  if (PY_PATTERNS.some((pattern) => pattern.test(file))) pyFiles.push(file)
}

if (tsFiles.length === 0 && goFiles.length === 0 && pyFiles.length === 0) {
  process.stdout.write('No style-checked source files changed.\n')
  process.exit(0)
}

// Windows caps the CreateProcess command line at 32k characters, so long file
// lists are dispatched in bounded batches on every platform.
function chunk(files, budget = 24000) {
  const batches = []
  let batch = []
  let length = 0
  for (const file of files) {
    if (batch.length > 0 && length + file.length + 1 > budget) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(file)
    length += file.length + 1
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) {
    process.stderr.write(`failed to run ${command}: ${result.error.message}\n`)
    process.exit(1)
  }
  return result
}

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python', 'python3']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return candidate
  }
  process.stderr.write('python interpreter not found; install Python or set PYTHON\n')
  process.exit(1)
}

let failed = false

if (tsFiles.length > 0) {
  const require = createRequire(join(root, 'package.json'))
  const prettierBin = join(dirname(require.resolve('prettier/package.json')), 'bin', 'prettier.cjs')
  for (const batch of chunk(tsFiles)) {
    const result = run(process.execPath, [prettierBin, fix ? '--write' : '--check', ...batch])
    if (result.status !== 0) failed = true
  }
}

if (goFiles.length > 0) {
  if (fix) {
    for (const batch of chunk(goFiles)) {
      const result = run('gofmt', ['-w', ...batch])
      if (result.status !== 0) failed = true
    }
  } else {
    let unformatted = ''
    for (const batch of chunk(goFiles)) {
      const result = run('gofmt', ['-l', ...batch], { stdio: ['ignore', 'pipe', 'inherit'] })
      if (result.status !== 0) failed = true
      unformatted += result.stdout?.toString() ?? ''
    }
    if (unformatted.trim().length > 0) {
      process.stdout.write(unformatted)
      process.stderr.write('Go files must be formatted with gofmt.\n')
      failed = true
    }
  }
}

if (pyFiles.length > 0) {
  const python = resolvePython()
  for (const batch of chunk(pyFiles)) {
    const result = run(python, ['-m', 'ruff', 'format', ...(fix ? [] : ['--check']), ...batch])
    if (result.status !== 0) failed = true
  }
}

process.exit(failed ? 1 : 0)
