// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Drift guard and behavioural tests for the env schema: pinned-var enforcement, dev.env render, _FILE secret resolution.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ENV_SCHEMA, envEntries } from '../../../../packages/engine/src/envSchema.ts'
import { loadEnv, PinnedVarError, readDotenv } from '../../../../packages/engine/src/envLoad.ts'
import { renderDevEnv, renderOperatorTemplate } from '../../../../packages/engine/src/envRender.ts'

const repoRoot = resolve(__dirname, '..', '..', '..', '..')

describe('envSchema', () => {
  it('dev.env on disk matches renderDevEnv output (drift guard)', () => {
    const path = resolve(repoRoot, 'infra', 'docker', 'dev.env')
    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).toBe(renderDevEnv())
  })

  it('renderOperatorTemplate emits only exposed, non-secret, non-pinned vars and comments them all out', () => {
    const out = renderOperatorTemplate('stable')
    for (const [key, spec] of envEntries()) {
      const present = out.includes(`# ${key}=`) || out.includes(`${key}=`)
      const shouldAppear = !spec.secret && Boolean(spec.exposed) && !spec.pinned?.includes('stable')
      expect(present).toBe(shouldAppear)
    }
    for (const line of out.split('\n')) {
      if (!line.startsWith('#') && line.includes('=')) throw new Error(`uncommented line in template: ${line}`)
    }
  })

  it('loadEnv applies dev defaults when no override is provided', () => {
    const values = loadEnv({ mode: 'dev', pins: {}, processEnv: {} })
    expect(values.CARACAL_MODE).toBe('dev')
    expect(values.CARACAL_REGISTRY).toBe('ghcr.io/garudex-labs/')
    expect(values.LOG_LEVEL).toBe('info')
  })

  it('loadEnv rejects pinned-var overrides in stable mode', () => {
    expect(() =>
      loadEnv({
        mode: 'stable',
        pins: { CARACAL_VERSION: '2026.05.14' },
        processEnv: { CARACAL_VERSION: '9999.99.99' },
      }),
    ).toThrow(PinnedVarError)
  })

  it('loadEnv resolves secrets via *_FILE convention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-env-'))
    try {
      const file = join(dir, 'postgresPassword')
      writeFileSync(file, 'sup3r-s3cret\n')
      const values = loadEnv({
        mode: 'dev',
        pins: {},
        processEnv: { POSTGRES_PASSWORD_FILE: file },
      })
      expect(values.POSTGRES_PASSWORD).toBe('sup3r-s3cret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readDotenv strips comments, blanks, and quoted values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-env-'))
    try {
      const file = join(dir, 'override.env')
      writeFileSync(file, '# leading comment\nFOO=bar\nBAZ="quoted value"\n\nEMPTY=\n')
      const out = readDotenv(file)
      expect(out.FOO).toBe('bar')
      expect(out.BAZ).toBe('quoted value')
      expect(out.EMPTY).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('schema enumerates every secret declared in SECRET_FILES', () => {
    const secrets = envEntries().filter(([, s]) => s.secret).map(([k]) => k)
    expect(secrets).toContain('POSTGRES_PASSWORD')
    expect(secrets).toContain('REDIS_PASSWORD')
    expect(secrets).toContain('CARACAL_ADMIN_TOKEN')
    expect(secrets).toContain('CARACAL_COORDINATOR_TOKEN')
    expect(secrets).toContain('ZONE_KEK')
    expect(secrets).toContain('AUDIT_HMAC_KEY')
    expect(secrets).toContain('STREAMS_HMAC_KEY')
  })
})
