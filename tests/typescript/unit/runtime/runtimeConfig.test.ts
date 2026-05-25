// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for runtime config path precedence and production service URL strictness.

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_API_URL,
  RuntimeConfigPermissionError,
  assertRuntimeConfigFileSecure,
  defaultRuntimeConfigPath,
  ServiceUrlMissingError,
  resolveRuntimeConfigPath,
  resolveServiceUrl,
} from '../../../../packages/engine/src/runtimeConfig.ts'

let root: string
let cwdBefore: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caracal-consolecfg-'))
  cwdBefore = process.cwd()
})

afterEach(() => {
  process.chdir(cwdBefore)
  rmSync(root, { recursive: true, force: true })
  delete process.env.CARACAL_CONFIG
  delete process.env.PWD
  delete process.env.INIT_CWD
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CARACAL_API_URL
  delete process.env.NODE_ENV
})

describe('resolveRuntimeConfigPath', () => {
  it('uses CARACAL_CONFIG first when present', () => {
    const explicit = join(root, 'explicit.toml')
    writeFileSync(explicit, 'zone_id = "z1"\n')
    process.env.CARACAL_CONFIG = explicit

    expect(resolveRuntimeConfigPath()).toBe(explicit)
  })

  it('does not load project-local config from cwd, PWD, or INIT_CWD', () => {
    const cwdDir = join(root, 'cwd')
    const pwdDir = join(root, 'pwd')
    const initDir = join(root, 'init')
    mkdirSync(cwdDir, { recursive: true })
    mkdirSync(pwdDir, { recursive: true })
    mkdirSync(initDir, { recursive: true })
    process.chdir(cwdDir)
    process.env.PWD = pwdDir
    process.env.INIT_CWD = initDir

    writeFileSync(join(cwdDir, 'caracal.toml'), 'zone_id = "cwd"\n')
    writeFileSync(join(pwdDir, 'caracal.toml'), 'zone_id = "pwd"\n')
    writeFileSync(join(initDir, 'caracal.toml'), 'zone_id = "init"\n')

    expect(resolveRuntimeConfigPath()).toBeUndefined()
  })

  it('falls back to XDG config path when explicit config is absent', () => {
    const cwdDir = join(root, 'cwd')
    const xdg = join(root, 'xdg')
    const xdgConfig = join(xdg, 'caracal', 'caracal.toml')
    mkdirSync(cwdDir, { recursive: true })
    mkdirSync(join(xdg, 'caracal'), { recursive: true })
    process.chdir(cwdDir)
    process.env.XDG_CONFIG_HOME = xdg
    writeFileSync(xdgConfig, 'zone_id = "xdg"\n')

    expect(resolveRuntimeConfigPath()).toBe(xdgConfig)
  })

  it('exposes the XDG config path for generators', () => {
    const xdg = join(root, 'xdg')
    process.env.XDG_CONFIG_HOME = xdg

    expect(defaultRuntimeConfigPath()).toBe(join(xdg, 'caracal', 'caracal.toml'))
  })

  it('returns undefined when no candidates exist', () => {
    const cwdDir = join(root, 'cwd')
    mkdirSync(cwdDir, { recursive: true })
    process.chdir(cwdDir)

    expect(resolveRuntimeConfigPath()).toBeUndefined()
  })

  it('does not fall back when explicit config is missing', () => {
    const cwdDir = join(root, 'cwd')
    const xdg = join(root, 'xdg')
    mkdirSync(cwdDir, { recursive: true })
    mkdirSync(join(xdg, 'caracal'), { recursive: true })
    process.chdir(cwdDir)
    process.env.CARACAL_CONFIG = join(root, 'missing.toml')
    process.env.XDG_CONFIG_HOME = xdg
    const cwdConfig = join(cwdDir, 'caracal.toml')
    const xdgConfig = join(xdg, 'caracal', 'caracal.toml')
    writeFileSync(cwdConfig, 'zone_id = "cwd"\n')
    writeFileSync(xdgConfig, 'zone_id = "xdg"\n')

    expect(resolveRuntimeConfigPath()).toBeUndefined()
  })

  it('rejects group-readable runtime config files on POSIX platforms', () => {
    if (process.platform === 'win32') return
    const path = join(root, 'caracal.toml')
    writeFileSync(path, 'zone_id = "z1"\n')
    chmodSync(path, 0o640)

    expect(() => assertRuntimeConfigFileSecure(path)).toThrow(RuntimeConfigPermissionError)
  })

  it('accepts owner-only runtime config files', () => {
    const path = join(root, 'caracal.toml')
    writeFileSync(path, 'zone_id = "z1"\n')
    if (process.platform !== 'win32') chmodSync(path, 0o600)

    expect(() => assertRuntimeConfigFileSecure(path)).not.toThrow()
  })
})

describe('resolveServiceUrl', () => {
  it('returns explicit env override in all environments', () => {
    process.env.CARACAL_API_URL = 'https://api.example.test'
    process.env.NODE_ENV = 'production'

    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe('https://api.example.test')
  })

  it('returns development default when unset in development mode', () => {
    process.env.NODE_ENV = 'development'

    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe(DEFAULT_API_URL)
  })

  it('treats unset NODE_ENV as development for local runtime and Console runs', () => {
    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe(DEFAULT_API_URL)
  })

  it('throws ServiceUrlMissingError when unset in non-development mode', () => {
    process.env.NODE_ENV = 'production'

    expect(() => resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toThrow(ServiceUrlMissingError)
    try {
      resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
    } catch (err) {
      expect((err as ServiceUrlMissingError).envKey).toBe('CARACAL_API_URL')
      expect((err as ServiceUrlMissingError).nodeEnv).toBe('production')
    }
  })

  it('treats empty production overrides as missing service URLs', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_API_URL = ''

    expect(() => resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toThrow(ServiceUrlMissingError)
  })
})
