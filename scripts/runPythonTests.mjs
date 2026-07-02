#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runs the Python package test suite with a platform-correct PYTHONPATH.

import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_PATHS = [
  'packages/core/python',
  'packages/identity/python',
  'packages/oauth/python',
  'packages/revocation/python',
  'packages/transport/mcp/python',
  'packages/connectors/fastmcp/python',
  'packages/connectors/asgi/python',
  'packages/connectors/redis/python',
  'packages/sdk/python',
  'tests/shared/test-utils/python',
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

const pythonPath = PACKAGE_PATHS.map((entry) => join(root, entry)).join(delimiter)
const result = spawnSync(
  resolvePython(),
  ['-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_*.py', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: pythonPath },
  },
)
if (result.error) {
  process.stderr.write(`failed to run python: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
