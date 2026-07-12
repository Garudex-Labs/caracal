#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Thin wrapper delegating dev secret bootstrap to @caracalai/engine.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const enginePkg = resolve(repoRoot, 'packages', 'engine')
const engineDist = resolve(enginePkg, 'dist', 'index.js')

if (!existsSync(engineDist)) {
  console.error('engine not built; running pnpm --filter @caracalai/engine build')
  const r = spawnSync('pnpm', ['--filter', '@caracalai/engine', 'build'], { stdio: 'inherit', cwd: repoRoot })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const { bootstrapSecrets, prepareDevSecrets } = await import(pathToFileURL(engineDist).href)
const paths = prepareDevSecrets(repoRoot)
const report = bootstrapSecrets(paths)

for (const name of report.filesCreated) console.log(`wrote ${name}`)
if (report.filesCreated.length === 0) {
  console.log('all secrets already provisioned')
}

console.log('')
console.log(`operator secret files under ${paths.secretsDir}`)
