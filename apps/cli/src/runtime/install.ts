// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime mode helpers: locate $CARACAL_HOME, install bundled assets, generate secrets.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { COMPOSE_YML, ENV_EXAMPLE, PROVISION_STREAMS_SH } from '../runtime/embedded.ts'

export interface RuntimePaths {
  home: string
  composeFile: string
  envFile: string
  provisionScript: string
}

export function defaultRuntimeHome(): string {
  if (process.env.CARACAL_HOME) return process.env.CARACAL_HOME
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'caracal')
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'caracal')
}

export function runtimePaths(home: string = defaultRuntimeHome()): RuntimePaths {
  return {
    home,
    composeFile: join(home, 'compose.yml'),
    envFile: join(home, '.env'),
    provisionScript: join(home, 'provision-streams.sh'),
  }
}

function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

function hexSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

function seedEnv(template: string): string {
  return template
    .replace(/^(POSTGRES_PASSWORD)=$/m, `$1=${randomSecret(18)}`)
    .replace(/^(REDIS_PASSWORD)=$/m, `$1=${randomSecret(18)}`)
    .replace(/^(CARACAL_ADMIN_TOKEN)=$/m, `$1=${randomSecret(24)}`)
    .replace(/^(ZONE_KEK)=$/m, `$1=${hexSecret(32)}`)
    .replace(/^(AUDIT_HMAC_KEY)=$/m, `$1=${hexSecret(32)}`)
    .replace(/^(STREAMS_HMAC_KEY)=$/m, `$1=${hexSecret(32)}`)
}

export function installRuntimeAssets(paths: RuntimePaths = runtimePaths()): { created: boolean } {
  mkdirSync(paths.home, { recursive: true })
  let created = false

  if (!existsSync(paths.composeFile)) {
    writeFileSync(paths.composeFile, COMPOSE_YML, { mode: 0o644 })
    created = true
  }
  if (!existsSync(paths.provisionScript)) {
    writeFileSync(paths.provisionScript, PROVISION_STREAMS_SH, { mode: 0o644 })
    chmodSync(paths.provisionScript, 0o755)
    created = true
  }
  if (!existsSync(paths.envFile)) {
    writeFileSync(paths.envFile, seedEnv(ENV_EXAMPLE), { mode: 0o600 })
    created = true
  }
  return { created }
}

export function seedEnvFile(envFile: string, mode = 0o600): { seeded: boolean } {
  if (!existsSync(envFile)) return { seeded: false }
  const original = readFileSync(envFile, 'utf8')
  const updated = seedEnv(original)
  if (updated === original) return { seeded: false }
  writeFileSync(envFile, updated, { mode })
  return { seeded: true }
}

