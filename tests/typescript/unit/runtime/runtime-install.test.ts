// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the runtime asset installer, version guard, stack lock, and upgrade journal.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireStackLock,
  appendUpgradeRecord,
  compareCaracalVersions,
  installRuntimeAssets,
  readRuntimeVersion,
  RuntimeDowngradeError,
  runtimePaths,
  StackLockError,
} from '@caracalai/engine'

describe('runtime installer', () => {
  it('runtimePaths honours CARACAL_HOME for end-user package installs', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-home-'))
    const saved = process.env.CARACAL_HOME
    try {
      process.env.CARACAL_HOME = home
      const paths = runtimePaths()
      expect(paths.home).toBe(home)
      expect(paths.composeFile).toBe(join(home, 'compose.yml'))
      expect(paths.secretsDir).toBe(join(home, 'secrets'))
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
    expect(compose).toContain('caracal-node:v${CARACAL_VERSION}')
    for (const port of ['5432', '6379', '8080', '3000', '8081', '9090', '4000']) {
      expect(compose).toMatch(new RegExp(`['"]127\\.0\\.0\\.1:${port}:${port}['"]`))
      expect(compose).not.toMatch(new RegExp(`^\\s*-\\s*['"]${port}:${port}['"]`, 'm'))
    }

    const env = readFileSync(paths.overrideEnvFile, 'utf8')
    expect(env).not.toMatch(/^POSTGRES_PASSWORD=/m)
    expect(env).not.toMatch(/^REDIS_PASSWORD=/m)
    expect(env).not.toMatch(/^CARACAL_ADMIN_TOKEN=/m)
    for (const line of env.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue
      throw new Error(`uncommented entry in operator template: ${line}`)
    }

    if (process.platform !== 'win32') {
      expect(statSync(paths.overrideEnvFile).mode & 0o777).toBe(0o600)
    }
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
    expect(compose).toContain('caracal-node:v${CARACAL_VERSION}')
    expect(compose).not.toContain('name: stale')
    const env = readFileSync(paths.overrideEnvFile, 'utf8')
    expect(env).toBe('# operator override\n# LOG_LEVEL=info\n')
  })

  it('tightens permissions on a pre-existing world-readable env file', () => {
    if (process.platform === 'win32') return
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

  it('bootstraps secret files under a private home/secrets directory with read-only mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const result = installRuntimeAssets(runtimePaths(home))
    expect(result.filesCreated.length).toBeGreaterThan(0)
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700)
    }
    for (const name of ['postgresPassword', 'redisPassword', 'caracalAdminToken', 'secretStoreKek']) {
      const secretPath = join(home, 'secrets', name)
      if (process.platform !== 'win32') {
        expect(statSync(secretPath).mode & 0o777).toBe(0o444)
      }
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

  it('records the installing version in the runtime marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)

    installRuntimeAssets(paths, 'stable', '2026.06.21')

    expect(readRuntimeVersion(home)).toBe('2026.06.21')
    installRuntimeAssets(paths, 'stable', '2026.07.01')
    expect(readRuntimeVersion(home)).toBe('2026.07.01')
  })

  it('refuses to install assets from an older binary and leaves the home untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths, 'stable', '2026.07.01')
    writeFileSync(paths.composeFile, 'name: current\n')

    expect(() => installRuntimeAssets(paths, 'stable', '2026.06.21')).toThrow(RuntimeDowngradeError)

    expect(readFileSync(paths.composeFile, 'utf8')).toBe('name: current\n')
    expect(readRuntimeVersion(home)).toBe('2026.07.01')
  })

  it('skips the downgrade guard when no version is supplied or no marker exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-runtime-'))
    const paths = runtimePaths(home)
    installRuntimeAssets(paths, 'stable', '2026.07.01')

    expect(() => installRuntimeAssets(paths, 'stable')).not.toThrow()
    expect(readRuntimeVersion(home)).toBe('2026.07.01')

    const fresh = runtimePaths(mkdtempSync(join(tmpdir(), 'caracal-runtime-')))
    expect(() => installRuntimeAssets(fresh, 'stable', '2026.06.21')).not.toThrow()
  })
})

describe('compareCaracalVersions', () => {
  it('orders calver, rc suffixes, and the semver baseline consistently', () => {
    expect(compareCaracalVersions('2026.06.21', '2026.06.09')).toBeGreaterThan(0)
    expect(compareCaracalVersions('2026.06.09', '2026.06.21')).toBeLessThan(0)
    expect(compareCaracalVersions('2026.06.21', '2026.06.21')).toBe(0)
    expect(compareCaracalVersions('2026.06.21-rc.1', '2026.06.21')).toBeLessThan(0)
    expect(compareCaracalVersions('2026.06.21-rc.2', '2026.06.21-rc.1')).toBeGreaterThan(0)
    expect(compareCaracalVersions('v2026.06.21', '2026.06.21')).toBe(0)
    expect(compareCaracalVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareCaracalVersions('1.1.0', '1.0.9')).toBeGreaterThan(0)
  })
})

describe('stack lock', () => {
  it('serializes concurrent commands and releases on completion', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-lock-'))

    const release = acquireStackLock(home)
    expect(existsSync(join(home, '.lock'))).toBe(true)
    expect(() => acquireStackLock(home)).toThrow(StackLockError)

    release()
    expect(existsSync(join(home, '.lock'))).toBe(false)
    acquireStackLock(home)()
  })

  it('takes over a stale lock left by a dead process', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-lock-'))
    writeFileSync(join(home, '.lock'), '999999999\n')

    const release = acquireStackLock(home)

    expect(readFileSync(join(home, '.lock'), 'utf8').trim()).toBe(String(process.pid))
    release()
  })
})

describe('upgrade journal', () => {
  it('appends JSON lines with timestamp, versions, and outcome', () => {
    const home = mkdtempSync(join(tmpdir(), 'caracal-journal-'))

    appendUpgradeRecord(home, { from: '2026.06.09', to: '2026.06.21', outcome: 'success' })
    appendUpgradeRecord(home, { to: '2026.06.21', outcome: 'migrationFailed' })

    const lines = readFileSync(join(home, 'upgrade.log'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first).toMatchObject({ from: '2026.06.09', to: '2026.06.21', outcome: 'success' })
    expect(new Date(first.at).getTime()).toBeGreaterThan(0)
    expect(JSON.parse(lines[1]).outcome).toBe('migrationFailed')
  })
})
