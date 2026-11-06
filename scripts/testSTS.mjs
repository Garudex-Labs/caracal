#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Scoped STS/Gateway tests and benchmarks with a read-only Go source overlay.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'caracal-sts-tests-'))
const args = process.argv.slice(2)
let mode = 'test'
if (args[0] === '--bench' || args[0] === '--live' || args[0] === '--vet') mode = args.shift().slice(2)
let baseline
if (args[0] === '--baseline') {
  args.shift()
  baseline = args.shift()
}
if (baseline && mode !== 'bench') throw new Error('--baseline is only supported with --bench')
const overlay = { Replace: {} }
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (entry.name.endsWith('_test.go') && !(baseline && entry.name.startsWith('optimization_'))) {
      overlay.Replace[resolve(root, relative(join(root, 'tests/source/go'), path))] = path
    }
  }
}
function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
try {
  collect(join(root, 'tests/source/go/services/sts'))
  collect(join(root, 'tests/source/go/services/gateway'))
  if (baseline) {
    // Hide any staged optimized-only tests, including copies left by another
    // test runner. An overlay tombstone changes no working-tree file.
    for (const name of ['optimization_live_test.go', 'optimization_security_test.go']) {
      overlay.Replace[join(root, 'services/sts/internal', name)] = ''
    }
    // Use the same compiler, module versions, test fixtures and load generator.
    // Only the scoped implementation is taken from the requested Git revision.
    for (const name of ['db', 'exchange', 'jwt', 'refresh', 'secrets', 'server', 'subjectissuer']) {
      const path = `services/sts/internal/${name}.go`
      const result = spawnSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`cannot read baseline ${path}`)
      const copy = join(temp, `${name}.go`)
      writeFileSync(copy, result.stdout)
      overlay.Replace[join(root, path)] = copy
    }
  }
  const overlayPath = join(temp, 'overlay.json')
  writeFileSync(overlayPath, JSON.stringify(overlay))
  const common = [`-overlay=${overlayPath}`]
  if (mode === 'vet') {
    run('go', ['vet', ...common, ...args, './services/sts/...', './services/gateway/...'])
  } else if (mode === 'bench') {
    run('go', ['test', ...common, '-run=^$', '-bench=BenchmarkSTS', '-benchmem', ...args, './services/sts/internal'])
  } else if (mode === 'live') {
    if (!process.env.CARACAL_STS_TEST_DATABASE_URL || !process.env.CARACAL_STS_TEST_REDIS_URL) {
      throw new Error('--live requires disposable CARACAL_STS_TEST_DATABASE_URL and CARACAL_STS_TEST_REDIS_URL')
    }
    const binary = join(temp, 'gateway.test')
    run('go', ['test', ...common, '-race', '-c', '-o', binary, './services/gateway/internal'])
    run(
      'go',
      ['test', ...common, '-race', '-run=TestSTS(LocalDeployment|SharedNonce|GraphGuard)', '-count=1', ...args, './services/sts/internal'],
      {
        ...process.env,
        CARACAL_STS_TEST_GATEWAY_BIN: binary,
      },
    )
  } else {
    run('go', ['test', ...common, '-race', ...args, './services/sts/...', './services/gateway/...'])
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  rmSync(temp, { recursive: true, force: true })
}
