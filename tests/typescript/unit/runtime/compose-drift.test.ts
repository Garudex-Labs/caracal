// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Drift guard: every ${VAR:-default} substitution in docker-compose.yml must mirror the schema default for the active mode.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_SCHEMA, envEntries, resolveDefault } from '../../../../packages/engine/src/envSchema.ts'
import { COMPOSE_YML } from '../../../../packages/engine/src/embedded.ts'

const repoRoot = resolve(__dirname, '..', '..', '..', '..')

function extractSubs(yaml: string): Map<string, string> {
  const subs = new Map<string, string>()
  const re = /\$\{([A-Z_][A-Z0-9_]*):-([^${}][^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(yaml)) !== null) {
    const key = m[1]
    const def = m[2]
    if (!subs.has(key)) subs.set(key, def)
  }
  return subs
}

describe('docker-compose default substitutions', () => {
  it('every ${VAR:-default} in docker-compose.yml matches the dev schema default', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'docker-compose.yml'), 'utf8')
    const subs = extractSubs(yaml)
    const mismatches: string[] = []
    for (const [key, def] of subs) {
      if (!(key in ENV_SCHEMA)) continue
      const spec = ENV_SCHEMA[key as keyof typeof ENV_SCHEMA]
      if (spec.secret) continue
      const schemaDef = resolveDefault(spec, 'dev')
      if (schemaDef === undefined) continue
      if (def !== schemaDef) mismatches.push(`${key}: compose=${def} schema=${schemaDef}`)
    }
    expect(mismatches).toEqual([])
  })

  it('compose never inlines defaults for secrets', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'docker-compose.yml'), 'utf8')
    const subs = extractSubs(yaml)
    for (const [key, spec] of envEntries()) {
      if (!spec.secret) continue
      expect(subs.has(key)).toBe(false)
    }
  })

  it('dev compose builds local images and defaults services to dev mode', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'docker-compose.yml'), 'utf8')
    expect(yaml).toContain('build:')
    expect(yaml).toContain('${CARACAL_MODE:-dev}')
    expect(yaml).toContain('localhost/caracal-api:')
    expect(yaml).not.toContain('ghcr.io/garudex-labs/}caracal-api')
  })

  it('dev control service consumes the admin token as a file-backed secret', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'docker-compose.yml'), 'utf8')
    expect(yaml).toContain('source: caracalAdminToken')
    expect(yaml).toContain('CONTROL_API_TOKEN_FILE: /run/secrets/caracalAdminToken')
    expect(yaml).not.toContain('CONTROL_API_TOKEN: ${CARACAL_ADMIN_TOKEN:-}')
  })
})

describe('runtime-compose default substitutions', () => {
  it('every ${VAR:-default} in runtime-compose.yml matches the stable schema default', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'runtime-compose.yml'), 'utf8')
    const subs = extractSubs(yaml)
    const mismatches: string[] = []
    for (const [key, def] of subs) {
      if (!(key in ENV_SCHEMA)) continue
      const spec = ENV_SCHEMA[key as keyof typeof ENV_SCHEMA]
      if (spec.secret) continue
      const schemaDef = resolveDefault(spec, 'stable')
      if (schemaDef === undefined) continue
      if (def !== schemaDef) mismatches.push(`${key}: compose=${def} schema=${schemaDef}`)
    }
    expect(mismatches).toEqual([])
  })

  it('embedded COMPOSE_YML stays byte-for-byte in sync with runtime-compose.yml', () => {
    const runtimeCompose = readFileSync(resolve(repoRoot, 'infra', 'docker', 'runtime-compose.yml'), 'utf8')
    expect(COMPOSE_YML).toBe(runtimeCompose)
  })

  it('runtime compose uses release images, stable defaults, and no build contexts', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'runtime-compose.yml'), 'utf8')
    expect(yaml).toContain('${CARACAL_REGISTRY:-ghcr.io/garudex-labs/}caracal-api:v${CARACAL_VERSION}')
    expect(yaml).toContain('${CARACAL_MODE:-stable}')
    expect(yaml).not.toContain('build:')
    expect(yaml).not.toContain('-dev.sha')
  })

  it('runtime compose declares persistent volumes at the top level', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'runtime-compose.yml'), 'utf8')
    expect(yaml).toMatch(/\nvolumes:\n  postgresData:\n  redisData:\n  stsReplay:\n  gatewayReplay:\n?$/)
  })

  it('runtime compose never exposes container ports on non-loopback addresses', () => {
    const yaml = readFileSync(resolve(repoRoot, 'infra', 'docker', 'runtime-compose.yml'), 'utf8')
    expect(yaml).not.toMatch(/^\s*-\s*"\d+:\d+"/m)
    expect(yaml).not.toMatch(/^\s*-\s*"0\.0\.0\.0:\d+:\d+"/m)
  })
})
