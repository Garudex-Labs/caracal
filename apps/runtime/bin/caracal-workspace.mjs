#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace entry: locates the repo root, stamps a dev runtime identity, then delegates to the workspace shell.

import { execFileSync, execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'

function findRepoRoot(start) {
  let dir = start
  while (true) {
    if (existsSync(join(dir, 'apps/runtime/bin/caracal.mjs'))) return dir
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
      'If you installed the released runtime shell, remove the pnpm symlink so the installed binary wins:\n' +
      '  pnpm rm -g caracal   # or: rm "$(pnpm bin -g)/caracal"\n',
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
  ['packages/core/ts/src', 'packages/core/ts/dist/index.js'],
  ['packages/oauth/ts/src', 'packages/oauth/ts/dist/index.js'],
  ['packages/admin/ts/src', 'packages/admin/ts/dist/index.js'],
  ['packages/engine/src', 'packages/engine/dist/index.js'],
  ['packages/engine/src', 'packages/engine/dist/controlState.js'],
  ['packages/engine/src', 'packages/engine/dist/stack.js'],
]
if (tsBuilds.some((path) => !existsSync(join(root, path))) || staleBuilds.some(([source, output]) => sourceIsNewer(source, output))) {
  process.stderr.write('caracal: building TypeScript workspace packages…\n')
  try {
    execSync('pnpm run build:typescript', { cwd: root, stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(`caracal: failed to build TypeScript workspace packages: ${err?.message ?? err}\n`)
    process.exit(1)
  }
}

try {
  const sha = execFileSync('node', [join(root, 'apps/runtime/scripts/stampDev.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .toString()
    .trim()
  process.env.CARACAL_DEV_SHA = sha
} catch (err) {
  process.stderr.write(`caracal: failed to stamp dev version: ${err?.message ?? err}\n`)
  process.exit(1)
}

import(pathToFileURL(join(root, 'apps/runtime/bin/caracal.mjs')).href).catch((err) => {
  process.stderr.write(`caracal: ${err?.message ?? err}\n`)
  process.exit(1)
})
