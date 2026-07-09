#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Checks and formats primary-language source files with the pinned project style toolchain.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

let mode = 'changed'
let fix = false

for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case '--all':
      mode = 'all'
      break
    case '--staged':
      mode = 'staged'
      break
    case '--fix':
      fix = true
      break
    case '-h':
    case '--help':
      process.stdout.write(
        [
          'Usage: node scripts/checkStyle.mjs [--all|--staged] [--fix]',
          '  no flags : check files changed since the upstream branch, plus local edits',
          '  --all    : check all tracked primary-language source files',
          '  --staged : check files staged for commit; with --fix, restage formatted files',
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) {
    process.stderr.write(`failed to run ${command}: ${result.error.message}\n`)
    process.exit(1)
  }
  return result
}

function upstreamFiles() {
  const probe = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (probe.error || probe.status !== 0) return []
  return git(['diff', '--name-only', '--diff-filter=ACMRT', `${probe.stdout.trim()}...HEAD`])
}

function listCandidateFiles() {
  if (mode === 'all') return git(['ls-files'])
  if (mode === 'staged') return git(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'])
  const baseRef = process.env.STYLE_BASE_REF
  if (baseRef) return git(['diff', '--name-only', '--diff-filter=ACMRT', `${baseRef}...HEAD`])
  const combined = [
    ...upstreamFiles(),
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
]
const PY_PATTERNS = [/^packages\/.+\.py$/, /^tests\/python\/.+\.py$/, /^tests\/shared\/test-utils\/python\/.+\.py$/]

function partition(files) {
  const groups = { ts: [], go: [], py: [] }
  for (const file of files) {
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    if (EXCLUDED_SEGMENTS.test(file) || EXCLUDED_FILES.has(file)) continue
    if (TS_PATTERNS.some((pattern) => pattern.test(file))) groups.ts.push(file)
    if (file.endsWith('.go')) groups.go.push(file)
    if (PY_PATTERNS.some((pattern) => pattern.test(file))) groups.py.push(file)
  }
  return groups
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

function prettierBin() {
  const require = createRequire(join(root, 'package.json'))
  try {
    return join(dirname(require.resolve('prettier/package.json')), 'bin', 'prettier.cjs')
  } catch {
    process.stderr.write('prettier is not installed; run pnpm install\n')
    process.exit(1)
  }
}

function ruffPin() {
  const spec = readFileSync(join(root, 'scripts', 'pythonStyleRequirements.in'), 'utf8')
  const match = spec.match(/^ruff==(\S+)/m)
  if (!match) {
    process.stderr.write('scripts/pythonStyleRequirements.in must pin ruff==<version>\n')
    process.exit(1)
  }
  return match[1]
}

function ruffVersion(python) {
  const probe = spawnSync(python, ['-m', 'ruff', '--version'], { cwd: root, encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return null
  return probe.stdout.trim().replace(/^ruff\s+/, '')
}

// The gate only ever formats with the ruff version CI pins, so local fixes and
// CI checks cannot drift; a matching interpreter is bootstrapped when missing.
function resolveStylePython() {
  const pin = ruffPin()
  if (process.env.PYTHON) {
    const version = ruffVersion(process.env.PYTHON)
    if (version === pin) return process.env.PYTHON
    process.stderr.write(`$PYTHON has ruff ${version ?? 'missing'}; the style gate pins ruff ${pin} (scripts/pythonStyleRequirements.in)\n`)
    process.exit(1)
  }
  const venvDir = process.env.CARACAL_DEV_VENV || '.venv'
  const venvPython = join(root, venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  if (existsSync(venvPython) && ruffVersion(venvPython) === pin) return venvPython
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  for (const candidate of candidates) {
    if (ruffVersion(candidate) === pin) return candidate
  }
  process.stdout.write(`style: installing pinned ruff ${pin} into ${venvDir}\n`)
  if (!existsSync(venvPython)) {
    const base = candidates.find((candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0)
    if (!base) {
      process.stderr.write('python interpreter not found; install Python 3 or set PYTHON\n')
      process.exit(1)
    }
    if (run(base, ['-m', 'venv', venvDir]).status !== 0) process.exit(1)
  }
  const install = run(venvPython, [
    '-m',
    'pip',
    'install',
    '--quiet',
    '--require-hashes',
    '--requirement',
    'scripts/pythonStyleRequirements.lock',
  ])
  if (install.status !== 0 || ruffVersion(venvPython) !== pin) {
    process.stderr.write(`failed to install ruff ${pin} into ${venvDir}; run pnpm run setup\n`)
    process.exit(1)
  }
  return venvPython
}

let stylePython
function pythonForRuff() {
  if (!stylePython) stylePython = resolveStylePython()
  return stylePython
}

function runPrettier(files, write) {
  if (files.length === 0) return true
  const bin = prettierBin()
  let ok = true
  for (const batch of chunk(files)) {
    const result = run(process.execPath, [bin, write ? '--write' : '--check', '--log-level=warn', ...batch])
    if (result.status !== 0) ok = false
  }
  return ok
}

function runGofmt(files, write) {
  if (files.length === 0) return true
  let ok = true
  if (write) {
    for (const batch of chunk(files)) {
      if (run('gofmt', ['-w', ...batch]).status !== 0) ok = false
    }
    return ok
  }
  let unformatted = ''
  for (const batch of chunk(files)) {
    const result = run('gofmt', ['-l', ...batch], { stdio: ['ignore', 'pipe', 'inherit'] })
    if (result.status !== 0) ok = false
    unformatted += result.stdout?.toString() ?? ''
  }
  if (unformatted.trim().length > 0) {
    process.stdout.write(unformatted)
    process.stderr.write('Go files must be formatted with gofmt.\n')
    ok = false
  }
  return ok
}

function runRuff(files, write) {
  if (files.length === 0) return true
  let ok = true
  for (const batch of chunk(files)) {
    if (run(pythonForRuff(), ['-m', 'ruff', 'format', ...(write ? [] : ['--check']), ...batch]).status !== 0) ok = false
  }
  return ok
}

const candidates = listCandidateFiles()

// Staged files that also carry unstaged edits cannot be rewritten and restaged
// without sweeping those edits into the commit, so they are only checked.
const partialStaged = mode === 'staged' && fix ? new Set(git(['diff', '--name-only'])) : new Set()
const fixable = partition(fix ? candidates.filter((file) => !partialStaged.has(file)) : [])
const checkable = partition(fix ? candidates.filter((file) => partialStaged.has(file)) : candidates)

const total = [fixable, checkable].flatMap((groups) => [...groups.ts, ...groups.go, ...groups.py]).length
if (total === 0) {
  process.stdout.write('No style-checked source files changed.\n')
  process.exit(0)
}

let failed = false
let checkFailed = false

if (!runPrettier(fixable.ts, true)) failed = true
if (!runGofmt(fixable.go, true)) failed = true
if (!runRuff(fixable.py, true)) failed = true

if (!runPrettier(checkable.ts, false)) checkFailed = true
if (!runGofmt(checkable.go, false)) checkFailed = true
if (!runRuff(checkable.py, false)) checkFailed = true
if (checkFailed) failed = true

if (mode === 'staged' && fix) {
  for (const batch of chunk([...fixable.ts, ...fixable.go, ...fixable.py])) {
    if (run('git', ['add', '--', ...batch]).status !== 0) failed = true
  }
  if (checkFailed) {
    process.stderr.write('Staged files with unstaged edits need formatting: run "pnpm run style:fix", then stage them again.\n')
  }
}

if (failed && !fix) {
  process.stderr.write('Style gate failed. Run "pnpm run style:fix" to format the files above.\n')
}

process.exit(failed ? 1 : 0)
