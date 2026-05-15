// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared envfile tests covering admin-token discovery from runtime home.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverAdminToken, runtimeEnvFile } from '../../../../packages/core/ts/src/envfile.js'

describe('runtimeEnvFile', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('honours CARACAL_HOME', () => {
    process.env.CARACAL_HOME = '/tmp/caracal-test-home'
    expect(runtimeEnvFile()).toBe('/tmp/caracal-test-home/.env')
  })

  it('falls back to a platform default when CARACAL_HOME is unset', () => {
    delete process.env.CARACAL_HOME
    const path = runtimeEnvFile()
    expect(path.endsWith('/caracal/.env')).toBe(true)
  })
})

describe('discoverAdminToken', () => {
  const saved = { ...process.env }
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-envfile-'))
    cwd = mkdtempSync(join(tmpdir(), 'caracal-cwd-'))
    process.chdir(cwd)
    process.env = { ...saved }
    delete process.env.CARACAL_ADMIN_TOKEN
    delete process.env.CARACAL_ENV_FILE
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('returns the explicit value first', () => {
    expect(discoverAdminToken('explicit-token')).toBe('explicit-token')
  })

  it('reads from the runtime-home env file', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(dir, '.env'), 'CARACAL_ADMIN_TOKEN=runtime-token\n')
    expect(discoverAdminToken()).toBe('runtime-token')
  })

  it('prefers runtime-home over cwd .env', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(dir, '.env'), 'CARACAL_ADMIN_TOKEN=runtime-token\n')
    writeFileSync(join(cwd, '.env'), 'CARACAL_ADMIN_TOKEN=cwd-token\n')
    expect(discoverAdminToken()).toBe('runtime-token')
  })

  it('falls back to cwd/.env when runtime-home is empty', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(cwd, '.env'), 'CARACAL_ADMIN_TOKEN=cwd-token\n')
    expect(discoverAdminToken()).toBe('cwd-token')
  })

  it('falls back to cwd/infra/docker/.env for source-tree dev', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(cwd, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(cwd, 'infra', 'docker', '.env'), 'CARACAL_ADMIN_TOKEN=infra-token\n')
    expect(discoverAdminToken()).toBe('infra-token')
  })

  it('returns undefined when nothing matches', () => {
    process.env.CARACAL_HOME = dir
    expect(discoverAdminToken()).toBeUndefined()
  })
})
