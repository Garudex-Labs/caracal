#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Builds the 5 service images at localhost/caracal-<svc>:dev-<sha> for local release-style binary testing; no-op when CARACAL_RELEASE_VERSION is set (CI publish flow).

import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapSecrets, devBootstrapPaths } from '@caracalai/engine'

if (process.env.CARACAL_RELEASE_VERSION) {
  process.stdout.write('buildLocalImages: CARACAL_RELEASE_VERSION set; skipping local image build\n')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const composeFile = resolve(repoRoot, 'infra', 'docker', 'docker-compose.yml')
const envFile = resolve(repoRoot, 'infra', 'docker', '.env')

bootstrapSecrets(devBootstrapPaths(repoRoot))

function shortSha() {
  if (process.env.CARACAL_DEV_SHA) return process.env.CARACAL_DEV_SHA
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim()
  } catch {
    return 'nogit'
  }
}

const sha = shortSha()
const services = ['redis', 'sts', 'api', 'gateway', 'audit', 'coordinator']
process.stdout.write(`buildLocalImages: tagging localhost/caracal-<svc>:dev-${sha}\n`)

const args = ['compose']
if (existsSync(envFile)) args.push('--env-file', envFile)
args.push('-f', composeFile, 'build', ...services)
const res = spawnSync('docker', args, {
  stdio: 'inherit',
  cwd: repoRoot,
  env: { ...process.env, CARACAL_DEV_SHA: sha, CARACAL_MODE: 'dev' },
})
if (res.status !== 0) {
  process.stderr.write(`buildLocalImages: docker compose build exited ${res.status}\n`)
  process.exit(res.status ?? 1)
}

// Re-tag with the runtime compose's expected `:v<version>` pattern so the
// release binary can resolve `localhost/caracal-<svc>:v${CARACAL_VERSION}`
// where CARACAL_VERSION = `dev-<sha>` (from stampRelease).
const runtimeTag = `vdev-${sha}`
for (const svc of services) {
  const src = `localhost/caracal-${svc}:dev-${sha}`
  const dst = `localhost/caracal-${svc}:${runtimeTag}`
  const tag = spawnSync('docker', ['tag', src, dst], { stdio: 'inherit' })
  if (tag.status !== 0) {
    process.stderr.write(`buildLocalImages: docker tag ${src} ${dst} exited ${tag.status}\n`)
    process.exit(tag.status ?? 1)
  }
}
process.stdout.write(`buildLocalImages: also tagged localhost/caracal-<svc>:${runtimeTag}\n`)
