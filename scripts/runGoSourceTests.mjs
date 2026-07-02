#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Stages centralized Go source-package tests for a single command.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'tests', 'source', 'go')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const [command, ...args] = process.argv.slice(2)
if (!command) fail('usage: node scripts/runGoSourceTests.mjs <command> [args...]')
if (!existsSync(sourceDir)) fail(`missing Go source test directory: ${sourceDir}`)

function collectTestFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectTestFiles(path))
    else if (entry.isFile() && entry.name.endsWith('_test.go')) files.push(path)
  }
  return files
}

const staged = []
const sources = collectTestFiles(sourceDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
try {
  for (const source of sources) {
    const target = join(root, relative(sourceDir, source))
    if (existsSync(target)) {
      throw new Error(`refusing to overwrite existing test file: ${relative(root, target).split(sep).join('/')}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    staged.push(target)
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`)
  process.exitCode = result.status ?? 1
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  for (const target of staged) rmSync(target, { force: true })
}
