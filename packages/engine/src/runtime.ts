// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Installed stack helpers: locate $CARACAL_HOME and install bundled assets.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { COMPOSE_YML } from './embedded.js'
import { bootstrapSecrets, runtimeBootstrapPaths } from './secrets.js'
import { renderOperatorTemplate } from './envRender.js'
import type { StackMode } from './stackPaths.js'

export interface RuntimePaths {
  home: string
  composeFile: string
  secretsDir: string
  // Operator override file. Generated as a fully commented template on first
  // install and never overwritten if it already exists.
  overrideEnvFile: string
}

function defaultRuntimeHome(): string {
  if (process.env.CARACAL_HOME) return process.env.CARACAL_HOME
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return join(xdg, 'caracal')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'caracal')
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'caracal')
  return join(homedir(), '.local', 'share', 'caracal')
}

export function runtimePaths(home: string = defaultRuntimeHome()): RuntimePaths {
  return {
    home,
    composeFile: join(home, 'compose.yml'),
    secretsDir: process.env.CARACAL_SECRETS_DIR ?? join(home, 'secrets'),
    overrideEnvFile: join(home, 'caracal.env'),
  }
}

export interface InstallReport {
  created: boolean
  filesCreated: string[]
}

export function installRuntimeAssets(paths: RuntimePaths = runtimePaths(), mode: StackMode = 'stable'): InstallReport {
  mkdirSync(paths.home, { recursive: true })
  let created = false

  let existingCompose: string | null = null
  try {
    existingCompose = readFileSync(paths.composeFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existingCompose !== COMPOSE_YML) {
    writeFileSync(paths.composeFile, COMPOSE_YML, { mode: 0o644 })
    created = true
  }

  // Only seed the override template if missing; never clobber operator edits.
  try {
    writeFileSync(paths.overrideEnvFile, renderOperatorTemplate(mode), { mode: 0o600, flag: 'wx' })
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    try {
      chmodSync(paths.overrideEnvFile, 0o600)
    } catch {
      /* perms may be unsupported */
    }
  }

  const report = bootstrapSecrets({ ...runtimeBootstrapPaths(paths.home), secretsDir: paths.secretsDir })
  if (report.filesCreated.length > 0) created = true

  return { created, filesCreated: report.filesCreated }
}
