// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves StackPaths for dev, rc, and stable modes.

import { join } from 'node:path'
import { bootstrapSecrets, devBootstrapPaths } from './secrets.js'
import { installRuntimeAssets, runtimePaths } from './runtime.js'
import type { StackPaths } from './stack.js'
import type { CaracalMode } from '@caracalai/core'

export type StackMode = CaracalMode

export interface ResolveStackPathsOptions {
  mode?: StackMode
  repoRoot?: string
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
    throw new Error(
      "CARACAL_MODE=dev requires CARACAL_REPO_ROOT; invoke via 'pnpm caracal' from inside the repo.",
    )
  }
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? join(repoRoot, 'infra', 'docker', 'docker-compose.yml')
  const envFile = process.env.CARACAL_ENV_FILE ?? join(repoRoot, 'infra', 'docker', '.env')
  const report = bootstrapSecrets(devBootstrapPaths(repoRoot))
  if (report.envCreated) opts.onInfo?.(`created ${envFile} from .env.example`)
  if (report.filesCreated.length > 0) {
    opts.onInfo?.(`generated ${report.filesCreated.length} secret file(s) under infra/secrets/files`)
  }
  if (report.envUpdated && !report.envCreated) opts.onInfo?.(`synced secrets → ${envFile}`)
  return { composeFile, envFile, cwd: repoRoot, mode: 'dev' }
}

function installedPaths(opts: ResolveStackPathsOptions, mode: Exclude<StackMode, 'dev'>): StackPaths {
  const paths = runtimePaths()
  const report = installRuntimeAssets(paths)
  if (report.created) opts.onInfo?.(`provisioned runtime assets at ${paths.home}`)
  const composeFile = process.env.CARACAL_COMPOSE_FILE ?? paths.composeFile
  const envFile = process.env.CARACAL_ENV_FILE ?? paths.envFile
  return { composeFile, envFile, cwd: paths.home, mode }
}
