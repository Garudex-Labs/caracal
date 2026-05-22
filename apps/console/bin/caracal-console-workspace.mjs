#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace entry: locates the repo root, stamps a dev Terminal identity, then delegates to the workspace Terminal.

import { execFileSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'

function findRepoRoot(start) {
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'apps/terminal/bin/caracal-terminal.mjs'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const start = process.env.INIT_CWD || process.env.PWD || process.cwd()
const root = findRepoRoot(start)

if (!root) {
  process.stderr.write(
    'caracal-terminal: this binary is the pnpm workspace shim and only runs inside the Caracal monorepo.\n' +
      'If you installed the released Terminal, remove the pnpm symlink so the installed binary wins:\n' +
      '  pnpm rm -g caracal-terminal   # or: rm "$(pnpm bin -g)/caracal-terminal"\n',
  )
  process.exit(1)
}

process.env.CARACAL_REPO_ROOT = root

function newestMtime(path) {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  return readdirSync(path, { withFileTypes: true }).reduce((newest, entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules') return newest
    return Math.max(newest, newestMtime(join(path, entry.name)))
  }, stat.mtimeMs)
}

function sourceIsNewer(source, output) {
  const sourcePath = join(root, source)
  const outputPath = join(root, output)
  if (!existsSync(sourcePath) || !existsSync(outputPath)) return false
  return newestMtime(sourcePath) > statSync(outputPath).mtimeMs
}

const tsBuilds = [
  'packages/core/ts/dist/index.js',
  'packages/oauth/ts/dist/index.js',
  'packages/admin/ts/dist/index.js',
  'packages/engine/dist/index.js',
  'packages/engine/dist/controlAccess.js',
  'packages/engine/dist/controlState.js',
  'packages/engine/dist/stack.js',
]
const staleBuilds = [
  ['packages/engine/src', 'packages/engine/dist/index.js'],
  ['packages/engine/src', 'packages/engine/dist/controlState.js'],
  ['packages/engine/src', 'packages/engine/dist/stack.js'],
]
if (tsBuilds.some((path) => !existsSync(join(root, path))) || staleBuilds.some(([source, output]) => sourceIsNewer(source, output))) {
  process.stderr.write('caracal-terminal: building TypeScript workspace packages…\n')
  try {
    execFileSync('pnpm', ['run', 'build:typescript'], { cwd: root, stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(`caracal-terminal: failed to build TypeScript workspace packages: ${err?.message ?? err}\n`)
    process.exit(1)
  }
}

try {
  const sha = execFileSync('node', [join(root, 'apps/terminal/scripts/stampDev.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .toString()
    .trim()
  process.env.CARACAL_DEV_SHA = sha
} catch (err) {
  process.stderr.write(`caracal-terminal: failed to stamp dev version: ${err?.message ?? err}\n`)
  process.exit(1)
}

import(join(root, 'apps/terminal/bin/caracal-terminal.mjs')).catch((err) => {
  process.stderr.write(`caracal-terminal: ${err?.message ?? err}\n`)
  process.exit(1)
})
