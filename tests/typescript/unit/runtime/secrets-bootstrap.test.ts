// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for bootstrapSecrets: file generation, idempotency, derived URL rendering, and permissions.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bootstrapSecrets,
  devBootstrapPaths,
  runtimeBootstrapPaths,
  SECRET_FILES,
} from '../../../../packages/engine/src/secrets.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-secrets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('bootstrapSecrets', () => {
  it('generates every declared secret file with mode 0o444', () => {
    const report = bootstrapSecrets({ secretsDir: dir })
    expect(report.filesCreated.length).toBeGreaterThanOrEqual(SECRET_FILES.length)
    for (const spec of SECRET_FILES) {
      const path = join(dir, spec.fileName)
      const value = readFileSync(path, 'utf8').trim()
      expect(value.length).toBe(spec.bytes * 2)
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o444)
      }
    }
  })

  it('is idempotent: re-running preserves existing values', () => {
    bootstrapSecrets({ secretsDir: dir })
    const before: Record<string, string> = {}
    for (const spec of SECRET_FILES) {
      before[spec.fileName] = readFileSync(join(dir, spec.fileName), 'utf8')
    }
    const second = bootstrapSecrets({ secretsDir: dir })
    expect(second.filesCreated.length).toBe(0)
    for (const spec of SECRET_FILES) {
      expect(readFileSync(join(dir, spec.fileName), 'utf8')).toBe(before[spec.fileName])
    }
  })

  it('regenerates a missing primary secret', () => {
    bootstrapSecrets({ secretsDir: dir })
    const adminBefore = readFileSync(join(dir, 'caracalAdminToken'), 'utf8')
    rmSync(join(dir, 'caracalAdminToken'))
    const second = bootstrapSecrets({ secretsDir: dir })
    expect(second.filesCreated).toContain('caracalAdminToken')
    const adminAfter = readFileSync(join(dir, 'caracalAdminToken'), 'utf8')
    expect(adminAfter).not.toBe(adminBefore)
  })

  it('renders derived databaseUrl and redisUrl from credentials', () => {
    bootstrapSecrets({ secretsDir: dir, postgresUser: 'app', postgresDb: 'mydb' })
    const dbUrl = readFileSync(join(dir, 'databaseUrl'), 'utf8')
    const redisUrl = readFileSync(join(dir, 'redisUrl'), 'utf8')
    const pgPass = readFileSync(join(dir, 'postgresPassword'), 'utf8').trim()
    const redisPass = readFileSync(join(dir, 'redisPassword'), 'utf8').trim()
    expect(dbUrl).toBe(`postgres://app:${pgPass}@postgres:5432/mydb`)
    expect(redisUrl).toBe(`redis://:${redisPass}@redis:6379`)
  })

  it('rewrites derived URLs when an existing value is stale', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'databaseUrl'), 'postgres://stale')
    bootstrapSecrets({ secretsDir: dir })
    const dbUrl = readFileSync(join(dir, 'databaseUrl'), 'utf8')
    expect(dbUrl.startsWith('postgres://caracal:')).toBe(true)
  })

  it('devBootstrapPaths and runtimeBootstrapPaths resolve to distinct directories', () => {
    const repo = '/tmp/repo'
    const home = '/tmp/home'
    expect(devBootstrapPaths(repo).secretsDir).toBe('/tmp/repo/infra/secrets/files')
    expect(runtimeBootstrapPaths(home).secretsDir).toBe('/tmp/home/secrets')
  })

  it('every generated value is unique across files', () => {
    bootstrapSecrets({ secretsDir: dir })
    const values = SECRET_FILES.map((s) => readFileSync(join(dir, s.fileName), 'utf8').trim())
    expect(new Set(values).size).toBe(values.length)
  })
})
