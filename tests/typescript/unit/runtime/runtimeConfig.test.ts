// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for cli config path precedence and production service URL strictness.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_API_URL,
  defaultCliConfigPath,
  ServiceUrlMissingError,
  resolveCliConfigPath,
  resolveServiceUrl,
} from '../../../../packages/engine/src/cliconfig.ts'

let root: string
let cwdBefore: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caracal-clicfg-'))
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

describe('resolveCliConfigPath', () => {
  it('uses CARACAL_CONFIG first when present', () => {
    const explicit = join(root, 'explicit.toml')
    writeFileSync(explicit, 'zone_id = "z1"\n')
    process.env.CARACAL_CONFIG = explicit

    expect(resolveCliConfigPath()).toBe(explicit)
  })

  it('checks cwd before PWD and INIT_CWD', () => {
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

    expect(resolveCliConfigPath()).toBe(join(cwdDir, 'caracal.toml'))
  })

  it('falls back to XDG config path when project-level files are absent', () => {
    const cwdDir = join(root, 'cwd')
    const xdg = join(root, 'xdg')
    const xdgConfig = join(xdg, 'caracal', 'caracal.toml')
    mkdirSync(cwdDir, { recursive: true })
    mkdirSync(join(xdg, 'caracal'), { recursive: true })
    process.chdir(cwdDir)
    process.env.XDG_CONFIG_HOME = xdg
    writeFileSync(xdgConfig, 'zone_id = "xdg"\n')

    expect(resolveCliConfigPath()).toBe(xdgConfig)
  })

  it('exposes the XDG config path for generators', () => {
    const xdg = join(root, 'xdg')
    process.env.XDG_CONFIG_HOME = xdg

    expect(defaultCliConfigPath()).toBe(join(xdg, 'caracal', 'caracal.toml'))
  })

  it('returns undefined when no candidates exist', () => {
    const cwdDir = join(root, 'cwd')
    mkdirSync(cwdDir, { recursive: true })
    process.chdir(cwdDir)

    expect(resolveCliConfigPath()).toBeUndefined()
  })

  it('ignores missing explicit config and continues to project-level config', () => {
    const cwdDir = join(root, 'cwd')
    mkdirSync(cwdDir, { recursive: true })
    process.chdir(cwdDir)
    process.env.CARACAL_CONFIG = join(root, 'missing.toml')
    const cwdConfig = join(cwdDir, 'caracal.toml')
    writeFileSync(cwdConfig, 'zone_id = "cwd"\n')

    expect(resolveCliConfigPath()).toBe(cwdConfig)
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

  it('treats unset NODE_ENV as development for local CLI and TUI runs', () => {
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
