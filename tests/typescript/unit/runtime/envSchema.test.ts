// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Drift guard and rendering tests for the env schema: dev.env render, operator template, secret enumeration.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { envEntries } from '../../../../packages/engine/src/envSchema.ts'
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

  it('schema enumerates every secret declared in SECRET_FILES', () => {
    const secrets = envEntries()
      .filter(([, s]) => s.secret)
      .map(([k]) => k)
    expect(secrets).toContain('POSTGRES_PASSWORD')
    expect(secrets).toContain('REDIS_PASSWORD')
    expect(secrets).toContain('CARACAL_ADMIN_TOKEN')
    expect(secrets).toContain('CARACAL_COORDINATOR_TOKEN')
    expect(secrets).toContain('SECRET_STORE_KEK')
    expect(secrets).toContain('AUDIT_HMAC_KEY')
    expect(secrets).toContain('STREAMS_HMAC_KEY')
  })
})
