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
    delete process.env.CARACAL_REPO_ROOT
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

  it('honours CARACAL_ENV_FILE before runtime home', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(dir, '.env'), 'CARACAL_ADMIN_TOKEN=runtime-token\n')
    const explicitFile = join(cwd, 'explicit.env')
    writeFileSync(explicitFile, 'CARACAL_ADMIN_TOKEN=explicit-file-token\n')
    process.env.CARACAL_ENV_FILE = explicitFile
    expect(discoverAdminToken()).toBe('explicit-file-token')
  })

  it('reads source-tree env only when CARACAL_REPO_ROOT is set', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(cwd, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(cwd, 'infra', 'docker', '.env'), 'CARACAL_ADMIN_TOKEN=dev-token\n')
    expect(discoverAdminToken()).toBeUndefined()
    process.env.CARACAL_REPO_ROOT = cwd
    expect(discoverAdminToken()).toBe('dev-token')
  })

  it('ignores cwd .env in installed mode', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(cwd, '.env'), 'CARACAL_ADMIN_TOKEN=cwd-token\n')
    expect(discoverAdminToken()).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    process.env.CARACAL_HOME = dir
    expect(discoverAdminToken()).toBeUndefined()
  })
})
