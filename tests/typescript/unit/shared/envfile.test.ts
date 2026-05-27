// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript shared envfile tests covering admin-token discovery from secret files.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverAdminToken, discoverCoordinatorToken, discoverRepoRoot, installedHome, readEnvFile } from '../../../../packages/core/ts/src/envfile.js'

describe('installedHome', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('honours CARACAL_HOME', () => {
    process.env.CARACAL_HOME = '/tmp/caracal-test-home'
    expect(installedHome()).toBe('/tmp/caracal-test-home')
  })

  it('falls back to a platform default when CARACAL_HOME is unset', () => {
    delete process.env.CARACAL_HOME
    const path = installedHome()
    expect(path.endsWith('/caracal')).toBe(true)
  })

  it('uses XDG_DATA_HOME before the platform data-home fallback', () => {
    delete process.env.CARACAL_HOME
    process.env.XDG_DATA_HOME = '/tmp/caracal-xdg-data'

    expect(installedHome()).toBe('/tmp/caracal-xdg-data/caracal')
  })
})

describe('readEnvFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-envfile-parser-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses CRLF dotenv files with whitespace and quoted values', () => {
    const file = join(dir, 'operator.env')
    writeFileSync(file, 'FOO = bar\r\nBAZ="quoted value"\r\nSINGLE=\'single value\'\r\n')

    expect(readEnvFile(file)).toEqual({
      FOO: 'bar',
      BAZ: 'quoted value',
      SINGLE: 'single value',
    })
  })

  it('returns an empty object for missing files and ignores malformed keys', () => {
    const file = join(dir, 'operator.env')
    writeFileSync(file, 'lower=ignored\nBROKEN\nGOOD=value\n')

    expect(readEnvFile(join(dir, 'missing.env'))).toEqual({})
    expect(readEnvFile(file)).toEqual({ GOOD: 'value' })
  })
})

describe('discoverRepoRoot', () => {
  let dir: string
  let cwd: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-repo-root-'))
    cwd = process.cwd()
    process.chdir(dir)
    process.env = { ...saved }
    delete process.env.CARACAL_REPO_ROOT
  })

  afterEach(() => {
    process.env = { ...saved }
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds the current workspace when CARACAL_REPO_ROOT is not set', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    mkdirSync(join(dir, 'infra', 'secrets', 'files'), { recursive: true })

    expect(discoverRepoRoot()).toBe(dir)
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
    delete process.env.CARACAL_ADMIN_TOKEN_FILE
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

  it('honours CARACAL_ADMIN_TOKEN_FILE before installed home', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'installed-token\n')
    const explicit = join(cwd, 'token')
    writeFileSync(explicit, 'explicit-file-token\n')
    process.env.CARACAL_ADMIN_TOKEN_FILE = explicit
    expect(discoverAdminToken()).toBe('explicit-file-token')
  })

  it('reads from the installed-home secret file', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'installed-token\n')
    expect(discoverAdminToken()).toBe('installed-token')
  })

  it('reads development secret files from the current workspace', () => {
    process.env.CARACAL_HOME = dir
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages: []\n')
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalAdminToken'), 'dev-token\n')
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

  it('returns undefined when the secret file exists but is empty', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), '   \n')
    expect(discoverAdminToken()).toBeUndefined()
  })

  it('CARACAL_ADMIN_TOKEN env var beats secret file', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'from-file\n')
    process.env.CARACAL_ADMIN_TOKEN = 'from-env'
    expect(discoverAdminToken()).toBe('from-env')
  })

  it('can prefer generated admin tokens over stale env values', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'from-file\n')
    process.env.CARACAL_ADMIN_TOKEN = 'from-env'
    expect(discoverAdminToken(undefined, { preferGenerated: true })).toBe('from-file')
  })

  it('prefers installed admin tokens over workspace tokens for local installed stacks', () => {
    process.env.CARACAL_HOME = dir
    process.env.CARACAL_REPO_ROOT = cwd
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'installed-token\n')
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalAdminToken'), 'dev-token\n')

    expect(discoverAdminToken(undefined, { preferGenerated: true })).toBe('installed-token')
  })

  it('uses workspace admin tokens in dev mode', () => {
    process.env.CARACAL_HOME = dir
    process.env.CARACAL_REPO_ROOT = cwd
    process.env.CARACAL_MODE = 'dev'
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'installed-token\n')
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalAdminToken'), 'dev-token\n')

    expect(discoverAdminToken(undefined, { preferGenerated: true })).toBe('dev-token')
  })

  it('CARACAL_ENV_FILE is used only as a last resort', () => {
    process.env.CARACAL_HOME = dir
    const envFile = join(cwd, '.env')
    writeFileSync(envFile, 'CARACAL_ADMIN_TOKEN=fallback-env-file\n')
    process.env.CARACAL_ENV_FILE = envFile
    expect(discoverAdminToken()).toBe('fallback-env-file')
  })
})

describe('discoverCoordinatorToken', () => {
  const saved = { ...process.env }
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-coordinator-token-'))
    cwd = mkdtempSync(join(tmpdir(), 'caracal-coordinator-cwd-'))
    process.chdir(cwd)
    process.env = { ...saved }
    delete process.env.CARACAL_COORDINATOR_TOKEN
    delete process.env.CARACAL_COORDINATOR_TOKEN_FILE
    delete process.env.CARACAL_ENV_FILE
    delete process.env.CARACAL_REPO_ROOT
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(dir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('discovers file-backed coordinator operator tokens', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'installed-token\n')
    expect(discoverCoordinatorToken()).toBe('installed-token')
  })

  it('honours explicit coordinator token sources first', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'installed-token\n')
    const file = join(cwd, 'token')
    writeFileSync(file, 'file-token\n')
    process.env.CARACAL_COORDINATOR_TOKEN_FILE = file
    expect(discoverCoordinatorToken('explicit-token')).toBe('explicit-token')
    expect(discoverCoordinatorToken()).toBe('file-token')
    process.env.CARACAL_COORDINATOR_TOKEN = 'env-token'
    expect(discoverCoordinatorToken()).toBe('env-token')
  })

  it('can prefer generated coordinator tokens over stale env values', () => {
    process.env.CARACAL_HOME = dir
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'installed-token\n')
    process.env.CARACAL_COORDINATOR_TOKEN = 'stale-env-token'
    expect(discoverCoordinatorToken(undefined, { preferGenerated: true })).toBe('installed-token')
  })

  it('uses workspace coordinator tokens in dev mode', () => {
    process.env.CARACAL_HOME = dir
    process.env.CARACAL_REPO_ROOT = cwd
    process.env.CARACAL_MODE = 'dev'
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'installed-token\n')
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalCoordinatorToken'), 'dev-token\n')
    expect(discoverCoordinatorToken(undefined, { preferGenerated: true })).toBe('dev-token')
  })

  it('prefers installed coordinator tokens over workspace tokens for local installed stacks', () => {
    process.env.CARACAL_HOME = dir
    process.env.CARACAL_REPO_ROOT = cwd
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'installed-token\n')
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalCoordinatorToken'), 'dev-token\n')

    expect(discoverCoordinatorToken(undefined, { preferGenerated: true })).toBe('installed-token')
  })

  it('prefers current workspace coordinator tokens over stale env values', () => {
    process.env.CARACAL_HOME = dir
    process.env.CARACAL_COORDINATOR_TOKEN = 'stale-env-token'
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages: []\n')
    mkdirSync(join(cwd, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(cwd, 'infra', 'secrets', 'files', 'caracalCoordinatorToken'), 'dev-token\n')
    expect(discoverCoordinatorToken(undefined, { preferGenerated: true })).toBe('dev-token')
  })
})
