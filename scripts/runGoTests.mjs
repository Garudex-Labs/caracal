#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runs the Go test suite with race detection, staged source-package tests, and optional merged coverage output.

import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'tests', 'source', 'go')

const GO_PKGS = [
  './packages/core/go/...',
  './packages/admin/go/...',
  './services/sts/...',
  './services/audit/...',
  './services/gateway/...',
  './packages/verify/go/...',
  './packages/adapters/nethttp/go/...',
  './packages/backends/redis/go/...',
  './packages/identity/go/...',
  './packages/oauth/go/...',
  './packages/revocation/go/...',
  './packages/sdk/go/...',
]

const TEST_DIRS = [
  './tests/go/unit/revocation',
  './tests/go/unit/verify',
  './tests/go/unit/identity',
  './tests/go/unit/adapters/nethttp',
  './tests/go/contract/interoperability',
  './tests/go/property',
]

const COVERPKG = [
  'github.com/garudex-labs/caracal/packages/verify/go',
  'github.com/garudex-labs/caracal/packages/revocation/go',
  'github.com/garudex-labs/caracal/packages/identity/go',
  'github.com/garudex-labs/caracal/packages/adapters/nethttp/go',
].join(',')

function runStatus(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`failed to run ${command}: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

function run(command, args) {
  const status = runStatus(command, args)
  if (status !== 0) process.exit(status)
}

function goEnv(name) {
  const result = spawnSync('go', ['env', name], { cwd: root, encoding: 'utf8' })
  if (result.error) {
    process.stderr.write(`failed to read go env ${name}: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`failed to read go env ${name}\n`)
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

function raceArgs() {
  if (goEnv('CGO_ENABLED') !== '0') return ['-race']
  if (process.env.CI) {
    process.stderr.write('Go race tests require CGO_ENABLED=1; enable cgo for CI.\n')
    process.exit(1)
  }
  process.stderr.write('warning: CGO_ENABLED=0; running Go tests without -race.\n')
  return []
}

function collectTestFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectTestFiles(path))
    else if (entry.isFile() && entry.name.endsWith('_test.go')) files.push(path)
  }
  return files
}

function runWithStagedSourceTests(args) {
  if (!existsSync(sourceDir)) {
    process.stderr.write(`missing Go source test directory: ${sourceDir}\n`)
    process.exit(1)
  }
  const staged = []
  let status = 1
  try {
    for (const source of collectTestFiles(sourceDir).sort()) {
      const target = join(root, relative(sourceDir, source))
      const existing = existsSync(target) ? readFileSync(target) : null
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      staged.push({ existing, target })
    }
    status = runStatus('go', args)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    status = 1
  } finally {
    for (const { existing, target } of staged) {
      if (existing === null) rmSync(target, { force: true })
      else writeFileSync(target, existing)
    }
  }
  if (status !== 0) process.exit(status)
}

const mode = process.argv[2] ?? ''

if (mode === '--vet') {
  runWithStagedSourceTests(['vet', ...GO_PKGS])
} else if (mode === '--coverage') {
  const race = raceArgs()
  mkdirSync(join(root, 'coverage', 'go'), { recursive: true })
  runWithStagedSourceTests(['test', ...race, '-covermode=atomic', '-coverprofile=coverage/go/coverage.out', ...GO_PKGS])
  run('go', ['test', ...race, '-covermode=atomic', `-coverpkg=${COVERPKG}`, '-coverprofile=coverage/go/tests.out', ...TEST_DIRS])
  const merged = readFileSync(join(root, 'coverage', 'go', 'tests.out'), 'utf8')
    .split('\n')
    .slice(1)
    .join('\n')
  appendFileSync(join(root, 'coverage', 'go', 'coverage.out'), merged)
  run('go', ['tool', 'cover', '-func=coverage/go/coverage.out'])
} else if (mode === '') {
  const race = raceArgs()
  runWithStagedSourceTests(['test', ...race, ...GO_PKGS])
  run('go', ['test', ...race, ...TEST_DIRS])
} else {
  process.stderr.write('usage: node scripts/runGoTests.mjs [--coverage|--vet]\n')
  process.exit(2)
}
