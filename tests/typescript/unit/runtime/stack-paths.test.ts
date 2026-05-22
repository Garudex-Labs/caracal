// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for stack mode path resolution and env-file layering.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths } from '../../../../apps/cli/src/commands/stack.ts'

function repoFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'caracal-repo-'))
  const dockerDir = join(repoRoot, 'infra', 'docker')
  mkdirSync(dockerDir, { recursive: true })
  writeFileSync(join(dockerDir, 'docker-compose.yml'), 'name: caracal\n')
  writeFileSync(join(dockerDir, 'dev.env'), 'CARACAL_MODE=dev\n')
  return repoRoot
}

describe('resolvePaths', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('defaults to dev mode when CARACAL_REPO_ROOT is set and CARACAL_MODE is unset', () => {
    const repoRoot = repoFixture()
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)
    vi.stubEnv('CARACAL_MODE', undefined)

    const paths = resolvePaths()

    expect(paths.mode).toBe('dev')
    expect(paths.cwd).toBe(repoRoot)
  })

  it('uses dev mode and points envFiles at dev.env when no local.env exists', () => {
    const repoRoot = repoFixture()
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)

    const paths = resolvePaths()

    expect(paths.mode).toBe('dev')
    expect(paths.cwd).toBe(repoRoot)
    expect(paths.composeFile).toBe(join(repoRoot, 'infra', 'docker', 'docker-compose.yml'))
    expect(paths.envFiles).toEqual([join(repoRoot, 'infra', 'docker', 'dev.env')])
  })

  it('bootstraps dev secret files idempotently', () => {
    const repoRoot = repoFixture()
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)

    const paths = resolvePaths()

    expect(paths.mode).toBe('dev')
    for (const name of ['postgresPassword', 'redisPassword', 'caracalAdminToken', 'zoneKek', 'auditHmacKey', 'streamsHmacKey']) {
      const file = join(repoRoot, 'infra', 'secrets', 'files', name)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0)
    }

    const second = resolvePaths()
    expect(second.envFiles).toEqual(paths.envFiles)
  })

  it('includes local.env in envFiles when present (dev.env first, local.env second)', () => {
    const repoRoot = repoFixture()
    writeFileSync(join(repoRoot, 'infra', 'docker', 'local.env'), 'LOG_LEVEL=debug\n')
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)

    const paths = resolvePaths()

    expect(paths.envFiles).toEqual([
      join(repoRoot, 'infra', 'docker', 'dev.env'),
      join(repoRoot, 'infra', 'docker', 'local.env'),
    ])
  })

  it('honours CARACAL_COMPOSE_FILE in dev mode', () => {
    const repoRoot = repoFixture()
    const customCompose = join(repoRoot, 'infra', 'docker', 'custom-compose.yml')
    writeFileSync(customCompose, 'name: custom\n')
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', repoRoot)
    vi.stubEnv('CARACAL_COMPOSE_FILE', customCompose)

    const paths = resolvePaths()

    expect(paths.composeFile).toBe(customCompose)
  })

  it('uses stable mode and resolves a single operator override env file', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-home-'))
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', home)

    const paths = resolvePaths()

    expect(paths.mode).toBe('stable')
    expect(paths.cwd).toBe(home)
    expect(paths.composeFile).toBe(join(home, 'compose.yml'))
    expect(paths.envFiles).toEqual([join(home, 'caracal.env')])
    expect(existsSync(join(home, 'caracal.env'))).toBe(true)
  })

  it('stable mode installs runtime assets under CARACAL_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-home-'))
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', home)

    const paths = resolvePaths()

    expect(existsSync(paths.composeFile)).toBe(true)
    expect(existsSync(join(home, 'secrets', 'databaseUrl'))).toBe(true)
    expect(readFileSync(paths.envFiles[0], 'utf8')).toContain('Caracal stable stack')
  })

  it('honours CARACAL_COMPOSE_FILE and CARACAL_ENV_FILE in stable mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-home-'))
    const customCompose = join(home, 'operator-compose.yml')
    const customEnv = join(home, 'operator.env')
    writeFileSync(customCompose, 'name: operator\n')
    writeFileSync(customEnv, '# operator\n')
    vi.stubEnv('CARACAL_MODE', 'stable')
    vi.stubEnv('CARACAL_HOME', home)
    vi.stubEnv('CARACAL_COMPOSE_FILE', customCompose)
    vi.stubEnv('CARACAL_ENV_FILE', customEnv)

    const paths = resolvePaths()

    expect(paths.composeFile).toBe(customCompose)
    expect(paths.envFiles).toEqual([customEnv])
  })

  it('rc mode resolves the same layout as stable', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-home-'))
    vi.stubEnv('CARACAL_MODE', 'rc')
    vi.stubEnv('CARACAL_HOME', home)

    const paths = resolvePaths()

    expect(paths.mode).toBe('rc')
    expect(paths.envFiles).toEqual([join(home, 'caracal.env')])
  })

  it('exits when CARACAL_MODE is invalid', () => {
    vi.stubEnv('CARACAL_MODE', 'broken')
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })

    expect(() => resolvePaths()).toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits when dev mode is requested without CARACAL_REPO_ROOT', () => {
    vi.stubEnv('CARACAL_MODE', 'dev')
    vi.stubEnv('CARACAL_REPO_ROOT', undefined)
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })

    expect(() => resolvePaths()).toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
