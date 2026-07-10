#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runs the Python package test suite with a platform-correct PYTHONPATH and optional coverage output.

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGES = [
  { path: 'packages/core/python', module: 'caracalai_core' },
  { path: 'packages/admin/python', module: 'caracalai_admin' },
  { path: 'packages/identity/python', module: 'caracalai_identity' },
  { path: 'packages/oauth/python', module: 'caracalai_oauth' },
  { path: 'packages/revocation/python', module: 'caracalai_revocation' },
  { path: 'packages/verify/python', module: 'caracalai_verify' },
  { path: 'packages/adapters/fastmcp/python', module: 'caracalai_fastmcp' },
  { path: 'packages/adapters/asgi/python', module: 'caracalai_asgi' },
  { path: 'packages/backends/redis/python', module: 'caracalai_revocation_redis' },
  { path: 'packages/sdk/python', module: 'caracalai' },
  { path: 'tests/shared/test-utils/python', module: null },
]

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

const pythonPath = PACKAGES.map((pkg) => join(root, pkg.path)).join(delimiter)

function run(python, args) {
  const result = spawnSync(python, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: pythonPath },
  })
  if (result.error) {
    process.stderr.write(`failed to run python: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const args = process.argv.slice(2)
const coverage = args.includes('--coverage')
const discoverArgs = ['-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_*.py', ...args.filter((arg) => arg !== '--coverage')]
const python = resolvePython()

if (coverage) {
  const sources = PACKAGES.filter((pkg) => pkg.module)
    .map((pkg) => `${pkg.path}/${pkg.module}`)
    .join(',')
  mkdirSync(join(root, 'coverage', 'python'), { recursive: true })
  run(python, ['-m', 'coverage', 'run', `--source=${sources}`, ...discoverArgs])
  run(python, ['-m', 'coverage', 'xml', '-o', 'coverage/python/coverage.xml'])
  run(python, ['-m', 'coverage', 'report', '--show-missing'])
} else {
  run(python, discoverArgs)
}
