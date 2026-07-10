// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves StackPaths for dev, rc, and stable modes.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapSecrets, devBootstrapPaths, prepareDevSecrets } from './secrets.js'
import { installRuntimeAssets, runtimePaths } from './runtime.js'
import type { StackPaths } from './stack.js'
import type { CaracalMode } from '@caracalai/server-core'

export type StackMode = CaracalMode

const DEV_COMPOSE_DIR = ['infra', 'docker'] as const
const DEV_COMPOSE_FILENAME = 'docker-compose.yml'

export interface ResolveStackPathsOptions {
  mode?: StackMode
  home?: string
  repoRoot?: string
  // The release version this binary carries. Enables the downgrade guard and
  // version marker when runtime assets are provisioned.
  version?: string
  // When false, paths are resolved without installing assets or generating
  // secrets, for read-only commands and teardown flows.
  provision?: boolean
  onInfo?: (message: string) => void
}

export function resolveStackPaths(opts: ResolveStackPathsOptions = {}): StackPaths {
  const mode = opts.mode ?? defaultMode()
  if (mode === 'dev') return devPaths(opts)
  return installedPaths(opts, mode)
}

function defaultMode(): StackMode {
  const override = process.env.CARACAL_MODE
  if (override === 'dev' || override === 'rc' || override === 'stable') return override
  if (override) {
    throw new Error(`CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '${override}')`)
  }
  return process.env.CARACAL_REPO_ROOT ? 'dev' : 'stable'
}

function devPaths(opts: ResolveStackPathsOptions): StackPaths {
  const repoRoot = opts.repoRoot ?? process.env.CARACAL_REPO_ROOT
  if (!repoRoot) {
    throw new Error("CARACAL_MODE=dev requires CARACAL_REPO_ROOT; invoke via 'pnpm caracal' from inside the repo.")
  }
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? join(repoRoot, ...DEV_COMPOSE_DIR, DEV_COMPOSE_FILENAME)
  const defaultsEnvFile = join(repoRoot, ...DEV_COMPOSE_DIR, 'dev.env')
  const overrideEnvFile = join(repoRoot, ...DEV_COMPOSE_DIR, 'local.env')
  let secretsDir: string
  if (opts.provision === false) {
    secretsDir = devBootstrapPaths(repoRoot).secretsDir
  } else {
    const secrets = prepareDevSecrets(repoRoot)
    const report = bootstrapSecrets(secrets)
    if (report.filesCreated.length > 0) {
      opts.onInfo?.(`generated ${report.filesCreated.length} operator secret file(s) under ${secrets.secretsDir}`)
    }
    secretsDir = secrets.secretsDir
  }
  return {
    composeFile,
    envFiles: existsSync(overrideEnvFile) ? [defaultsEnvFile, overrideEnvFile] : [defaultsEnvFile],
    cwd: repoRoot,
    mode: 'dev',
    secretsDir,
  }
}

function installedPaths(opts: ResolveStackPathsOptions, mode: Exclude<StackMode, 'dev'>): StackPaths {
  const paths = runtimePaths(opts.home)
  if (opts.provision !== false) {
    const report = installRuntimeAssets(paths, mode, opts.version)
    if (report.created) opts.onInfo?.(`provisioned runtime assets at ${paths.home}`)
  }
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? paths.composeFile
  const overrideEnvFile = process.env.CARACAL_ENV_FILE ?? paths.overrideEnvFile
  return {
    composeFile,
    envFiles: [overrideEnvFile],
    cwd: paths.home,
    mode,
    secretsDir: paths.secretsDir,
  }
}
