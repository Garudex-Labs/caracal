#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runs every workspace package test suite, optionally with per-package vitest coverage output.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ENV_DEFAULTS = {
  DATABASE_URL: 'postgresql://caracal:caracal@localhost:5432/caracal',
  REDIS_URL: 'redis://localhost:6379',
  STS_URL: 'http://localhost:3001',
  ISSUER_URL: 'http://localhost:4000',
  AGENT_COORDINATOR_SCOPE: 'agent:coordinate',
}

const args = process.argv.slice(2)
const coverage = args.includes('--coverage')
const filters = args.filter((arg) => arg !== '--coverage')

function workspaceDirs() {
  const manifest = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs = []
  let inPackages = false
  for (const line of manifest.split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const entry = line.match(/^\s+-\s+'([^']+)'\s*$/)
    if (entry) {
      globs.push(entry[1])
      continue
    }
    if (line.trim() !== '') break
  }
  const dirs = []
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parent = join(root, glob.slice(0, -2))
      for (const child of readdirSync(parent, { withFileTypes: true })) {
        if (child.isDirectory()) dirs.push(join(parent, child.name))
      }
    } else {
      dirs.push(join(root, glob))
    }
  }
  return dirs.filter((dir) => existsSync(join(dir, 'package.json'))).sort()
}

const suites = []
for (const dir of workspaceDirs()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (!pkg.scripts?.test) continue
  const name = pkg.name.replace(/^@[^/]+\//, '')
  if (filters.length > 0 && !filters.includes(name)) continue
  suites.push({ dir, name })
}

if (filters.length > 0 && suites.length !== filters.length) {
  const known = new Set(suites.map((suite) => suite.name))
  process.stderr.write(`unknown package filter: ${filters.filter((name) => !known.has(name)).join(', ')}\n`)
  process.exit(1)
}

const env = { ...ENV_DEFAULTS, ...process.env }
for (const { dir, name } of suites) {
  process.stdout.write(process.env.GITHUB_ACTIONS ? `::group::test ${name}\n` : `\n== test ${name}\n`)
  const runArgs = ['--dir', dir, 'run', 'test']
  if (coverage) {
    runArgs.push(
      '--coverage.enabled',
      'true',
      '--coverage.provider=v8',
      '--coverage.reporter=lcov',
      `--coverage.reportsDirectory=${join(root, 'coverage', 'typescript', name)}`,
    )
  }
  const result = spawnSync('pnpm', runArgs, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  })
  if (process.env.GITHUB_ACTIONS) process.stdout.write('::endgroup::\n')
  if (result.error) {
    process.stderr.write(`failed to run pnpm: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
process.stdout.write(`\nran ${suites.length} package test suites\n`)
