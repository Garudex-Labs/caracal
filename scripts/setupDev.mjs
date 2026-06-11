#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Installs the local developer toolchain dependencies used by tests and style checks.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const python = process.env.PYTHON || 'python'
const venvDir = process.env.CARACAL_DEV_VENV || '.venv'
const venvPython = join(root, venvDir, isWindows ? 'Scripts/python.exe' : 'bin/python')
const editablePackages = [
  'packages/core/python',
  'packages/oauth/python',
  'packages/identity/python',
  'packages/revocation/python',
  'packages/sdk/python',
  'packages/transport/mcp/python',
  'packages/connectors/fastmcp/python',
  'packages/connectors/redis/python',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('pnpm', ['install', '--frozen-lockfile'])
run('go', ['mod', 'download'])

if (!existsSync(venvPython)) {
  run(python, ['-m', 'venv', venvDir])
}

run(venvPython, ['-m', 'pip', 'install', '--require-hashes', '--requirement', 'scripts/pythonTestRequirements.lock'])
run(venvPython, ['-m', 'pip', 'install', '--requirement', 'scripts/pythonStyleRequirements.in'])
run(venvPython, ['-m', 'pip', 'install', ...editablePackages.flatMap((path) => ['-e', path])])

const activate = isWindows ? `${venvDir}\\Scripts\\Activate.ps1` : `. ${venvDir}/bin/activate`
console.log(`Developer environment ready. Activate Python with: ${activate}`)
