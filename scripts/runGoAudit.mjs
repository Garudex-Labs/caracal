#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verify every Go module and scan imported code without staging source tests.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = readFileSync(resolve(root, 'go.work'), 'utf8')
const use = workspace.match(/\buse\s*\(([\s\S]*?)\)/)?.[1]
if (!use) throw new Error('go.work must declare workspace modules')
const modules = use
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, '').trim())
  .filter(Boolean)

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const standalone = ['./infra/healthcheck', './infra/postgres/gosu']
for (const module of [...modules, ...standalone]) {
  run('go', ['mod', 'verify'], resolve(root, module), {
    ...process.env,
    GOWORK: standalone.includes(module) ? 'off' : resolve(root, 'go.work'),
  })
}
if (!process.argv.includes('--verify-only')) {
  // govulncheck requires a module cwd even when package patterns span a workspace.
  const cwd = resolve(root, 'tests/go')
  run(
    'govulncheck',
    modules.map((module) => `../../${module.replace(/^\.\//, '')}/...`),
    cwd,
  )
  run('govulncheck', ['./...'], resolve(root, 'infra/healthcheck'), { ...process.env, GOWORK: 'off' })
  run('govulncheck', ['github.com/tianon/gosu'], resolve(root, 'infra/postgres/gosu'), { ...process.env, GOWORK: 'off' })
}
