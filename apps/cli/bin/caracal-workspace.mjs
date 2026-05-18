#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace entry: locates the repo root, stamps a dev CLI identity, then delegates to the workspace CLI.

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

function findRepoRoot(start) {
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'apps/cli/bin/caracal.mjs'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const start = process.env.INIT_CWD || process.env.PWD || process.cwd()
const root = findRepoRoot(start)

if (!root) {
  process.stderr.write(
    'caracal: this binary is the pnpm workspace shim and only runs inside the Caracal monorepo.\n' +
      'If you installed the released CLI, remove the pnpm symlink so the installed binary wins:\n' +
      '  pnpm rm -g caracal   # or: rm "$(pnpm bin -g)/caracal"\n',
  )
  process.exit(1)
}

process.env.CARACAL_REPO_ROOT = root

const tsBuilds = [
  'packages/core/ts/dist/index.js',
  'packages/admin/ts/dist/index.js',
  'packages/engine/dist/index.js',
]
if (tsBuilds.some((path) => !existsSync(join(root, path)))) {
  process.stderr.write('caracal: building TypeScript workspace packages (first run)…\n')
  try {
    execFileSync('pnpm', ['run', 'build:typescript'], { cwd: root, stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(`caracal: failed to build TypeScript workspace packages: ${err?.message ?? err}\n`)
    process.exit(1)
  }
}

try {
  const sha = execFileSync('node', [join(root, 'apps/cli/scripts/stampDev.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .toString()
    .trim()
  process.env.CARACAL_DEV_SHA = sha
} catch (err) {
  process.stderr.write(`caracal: failed to stamp dev version: ${err?.message ?? err}\n`)
  process.exit(1)
}

import(join(root, 'apps/cli/bin/caracal.mjs')).catch((err) => {
  process.stderr.write(`caracal: ${err?.message ?? err}\n`)
  process.exit(1)
})
