// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the runtime asset installer.

import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installRuntimeAssets, runtimePaths } from '../../../../packages/engine/dist/index.js'

describe('runtime installer', () => {
  it('runtimePaths honours CARACAL_HOME for end-user package installs', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-home-'))
    const saved = process.env.CARACAL_HOME
    try {
      process.env.CARACAL_HOME = home
      const paths = runtimePaths()
      expect(paths.home).toBe(home)
      expect(paths.composeFile).toBe(join(home, 'compose.yml'))
      expect(paths.overrideEnvFile).toBe(join(home, 'caracal.env'))
    } finally {
      if (saved === undefined) delete process.env.CARACAL_HOME
      else process.env.CARACAL_HOME = saved
    }
  })

  it('writes compose and operator template with secure modes', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    const result = installRuntimeAssets(paths)

    expect(result.created).toBe(true)

    const compose = readFileSync(paths.composeFile, 'utf8')
    expect(compose).toContain('caracal-api:v${CARACAL_VERSION}')
    for (const port of ['5432', '6379', '8080', '3000', '8081', '9090', '4000']) {
      expect(compose).toContain(`"127.0.0.1:${port}:${port}"`)
      expect(compose).not.toMatch(new RegExp(`^\\s*-\\s*"${port}:${port}"`, 'm'))
    }

    const env = readFileSync(paths.overrideEnvFile, 'utf8')
    expect(env).not.toMatch(/^POSTGRES_PASSWORD=/m)
    expect(env).not.toMatch(/^REDIS_PASSWORD=/m)
    expect(env).not.toMatch(/^CARACAL_ADMIN_TOKEN=/m)
    for (const line of env.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue
      throw new Error(`uncommented entry in operator template: ${line}`)
    }

    const envMode = statSync(paths.overrideEnvFile).mode & 0o777
    expect(envMode).toBe(0o600)
  })

  it('is idempotent: existing files are preserved', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths)
    const envBefore = readFileSync(paths.overrideEnvFile, 'utf8')
    const second = installRuntimeAssets(paths)
    expect(second.created).toBe(false)
    expect(readFileSync(paths.overrideEnvFile, 'utf8')).toBe(envBefore)
  })

  it('refreshes stale compose on upgrade without clobbering persisted operator env content', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths)
    writeFileSync(paths.composeFile, 'name: stale\n')
    writeFileSync(paths.overrideEnvFile, '# operator override\n# LOG_LEVEL=info\n')

    const result = installRuntimeAssets(paths, 'stable')

    expect(result.created).toBe(true)
    const compose = readFileSync(paths.composeFile, 'utf8')
    expect(compose).toContain('caracal-api:v${CARACAL_VERSION}')
    expect(compose).not.toContain('name: stale')
    const env = readFileSync(paths.overrideEnvFile, 'utf8')
    expect(env).toBe('# operator override\n# LOG_LEVEL=info\n')
  })

  it('tightens permissions on a pre-existing world-readable env file', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    mkdirSync(paths.home, { recursive: true })
    writeFileSync(paths.overrideEnvFile, '# operator overrides\n')
    chmodSync(paths.overrideEnvFile, 0o644)
    expect(statSync(paths.overrideEnvFile).mode & 0o777).toBe(0o644)
    installRuntimeAssets(paths)
    expect(statSync(paths.overrideEnvFile).mode & 0o777).toBe(0o600)
  })

  it('writes mode-specific operator templates that differ between rc and stable banners', () => {
    const homeRc = mkdtempSync(join(tmpdir(), 'caracal-runtime-rc-'))
    const homeStable = mkdtempSync(join(tmpdir(), 'caracal-runtime-stable-'))
    installRuntimeAssets(runtimePaths(homeRc), 'rc')
    installRuntimeAssets(runtimePaths(homeStable), 'stable')
    const rc = readFileSync(join(homeRc, 'caracal.env'), 'utf8')
    const stable = readFileSync(join(homeStable, 'caracal.env'), 'utf8')
    expect(rc).toContain('Caracal rc stack')
    expect(stable).toContain('Caracal stable stack')
    expect(rc).not.toBe(stable)
  })

  it('bootstraps secret files under home/secrets with 0o444 mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const result = installRuntimeAssets(runtimePaths(home))
    expect(result.filesCreated.length).toBeGreaterThan(0)
    for (const name of ['postgresPassword', 'redisPassword', 'caracalAdminToken', 'zoneKek']) {
      const secretPath = join(home, 'secrets', name)
      expect(statSync(secretPath).mode & 0o777).toBe(0o444)
      const value = readFileSync(secretPath, 'utf8').trim()
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('preserves non-empty operator secrets and regenerates empty secret files on upgrade', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths)
    const secretPath = join(home, 'secrets', 'postgresPassword')
    chmodSync(secretPath, 0o600)
    chmodSync(join(home, 'secrets', 'redisPassword'), 0o600)
    writeFileSync(secretPath, 'operator-secret\n', { mode: 0o600 })
    writeFileSync(join(home, 'secrets', 'redisPassword'), '\n', { mode: 0o600 })

    const result = installRuntimeAssets(paths)

    expect(result.filesCreated).toContain('redisPassword')
    expect(readFileSync(secretPath, 'utf8').trim()).toBe('operator-secret')
    expect(readFileSync(join(home, 'secrets', 'redisPassword'), 'utf8').trim().length).toBeGreaterThan(0)
    expect(readFileSync(join(home, 'secrets', 'redisUrl'), 'utf8')).toContain('@redis:6379')
  })

  it('does not persist pinned or secret values in end-user operator env files', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths, 'stable')

    const env = readFileSync(paths.overrideEnvFile, 'utf8')
    expect(env).not.toContain('CARACAL_VERSION=')
    expect(env).not.toContain('CARACAL_REGISTRY=')
    expect(env).not.toContain('CARACAL_MODE=')
    expect(env).not.toContain('POSTGRES_PASSWORD=')
    expect(env).toContain('# LOG_LEVEL=info')
  })

  it('compose file never references secret material directly', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths)
    const compose = readFileSync(paths.composeFile, 'utf8')
    for (const tail of ['POSTGRES_PASSWORD:', 'REDIS_PASSWORD:', 'CARACAL_ADMIN_TOKEN:']) {
      expect(compose).not.toContain(`\n      ${tail} `)
    }
    expect(compose).toMatch(/POSTGRES_PASSWORD_FILE/)
  })
})
