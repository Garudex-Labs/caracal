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
  RuntimeConfigValidationError,
  assertRuntimeConfigFileSecure,
  defaultRuntimeConfigPath,
  loadRuntimeConfig,
  ServiceUrlMissingError,
  resolveRuntimeConfigPath,
  resolveServiceUrl,
} from '../../../../packages/engine/src/runtimeConfig.ts'

let root: string
let cwdBefore: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caracal-consolecfg-'))
  cwdBefore = process.cwd()
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-default')
})

afterEach(() => {
  process.chdir(cwdBefore)
  rmSync(root, { recursive: true, force: true })
  delete process.env.CARACAL_CONFIG
  delete process.env.CARACAL_STS_URL
  delete process.env.CARACAL_ZONE_URL
  delete process.env.CARACAL_ZONE_ID
  delete process.env.CARACAL_APPLICATION_ID
  delete process.env.CARACAL_APP_CLIENT_SECRET
  delete process.env.CARACAL_APP_CLIENT_SECRET_FILE
  delete process.env.CARACAL_RUN_CREDENTIALS
  delete process.env.CARACAL_RUN_CREDENTIALS_FILE
  delete process.env.CARACAL_RUN_CONTINUE_ON_FAILURE
  delete process.env.CARACAL_RUN_TTL_SECONDS
  delete process.env.CARACAL_MCP_GOVERNANCE_MODE
  delete process.env.CARACAL_ALLOW_INSECURE_CONFIG_URLS
  delete process.env.CARACAL_ALLOW_MCP_GOVERNANCE_LOG
  delete process.env.CARACAL_ALLOW_REQUIRED_CREDENTIAL_FAILURE
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

  it('explains missing runtime config without recommending local TOML generation', () => {
    let message = ''
    try {
      loadRuntimeConfig(true)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('workload identity from env/secret files')
    expect(message).not.toMatch(/create .*caracal\.toml/)
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

  it('accepts explicit read-only runtime config files for secret mounts', () => {
    if (process.platform === 'win32') return
    const path = join(root, 'caracal.toml')
    writeFileSync(path, 'zone_id = "z1"\n')
    chmodSync(path, 0o444)

    expect(() => assertRuntimeConfigFileSecure(path, { CARACAL_CONFIG: path })).not.toThrow()
  })

  it('rejects explicit runtime config files with group or world write bits', () => {
    if (process.platform === 'win32') return
    const path = join(root, 'caracal.toml')
    writeFileSync(path, 'zone_id = "z1"\n')
    chmodSync(path, 0o666)

    expect(() => assertRuntimeConfigFileSecure(path, { CARACAL_CONFIG: path })).toThrow(RuntimeConfigPermissionError)
  })

  it('accepts owner-only runtime config files', () => {
    const path = join(root, 'caracal.toml')
    writeFileSync(path, 'zone_id = "z1"\n')
    if (process.platform !== 'win32') chmodSync(path, 0o600)

    expect(() => assertRuntimeConfigFileSecure(path)).not.toThrow()
  })

  it('loads and validates config files with secret-file references', () => {
    const secret = join(root, 'client-secret')
    const cfg = join(root, 'caracal.toml')
    writeFileSync(secret, 'secret-value\n')
    writeFileSync(cfg, [
      'zone_url = "https://sts.example.com"',
      'zone_id = "zone1"',
      'application_id = "app1"',
      `app_client_secret_file = "${secret}"`,
      '[[credentials]]',
      'env = "RESOURCE_TOKEN"',
      'resource = "resource://api"',
      'credential_type = "caracal_mandate"',
      '',
    ].join('\n'))
    if (process.platform !== 'win32') {
      chmodSync(secret, 0o444)
      chmodSync(cfg, 0o600)
    }
    process.env.CARACAL_CONFIG = cfg

    expect(loadRuntimeConfig(true)).toMatchObject({
      zone_url: 'https://sts.example.com',
      zone_id: 'zone1',
      application_id: 'app1',
      app_client_secret: 'secret-value',
      credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api', credential_type: 'caracal_mandate' }],
    })
  })

  it('loads runtime config from env and JSON credential manifests', () => {
    const secret = join(root, 'client-secret')
    const credentials = join(root, 'credentials.json')
    writeFileSync(secret, 'secret-value\n')
    writeFileSync(credentials, JSON.stringify({
      credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }],
      optional_credentials: [{ env: 'OPTIONAL_TOKEN', resource: 'resource://optional' }],
      mcp_governance: { mode: 'log' },
    }))
    if (process.platform !== 'win32') {
      chmodSync(secret, 0o444)
      chmodSync(credentials, 0o444)
    }
    process.env.CARACAL_STS_URL = 'https://sts.example.com'
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_APPLICATION_ID = 'app1'
    process.env.CARACAL_APP_CLIENT_SECRET_FILE = secret
    process.env.CARACAL_RUN_CREDENTIALS_FILE = credentials
    process.env.CARACAL_RUN_CONTINUE_ON_FAILURE = 'true'
    process.env.CARACAL_RUN_TTL_SECONDS = '600'
    process.env.CARACAL_MCP_GOVERNANCE_MODE = 'block'

    expect(loadRuntimeConfig(true)).toMatchObject({
      zone_url: 'https://sts.example.com',
      zone_id: 'zone1',
      application_id: 'app1',
      app_client_secret: 'secret-value',
      continue_on_failure: true,
      ttl_seconds: 600,
      credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }],
      optional_credentials: [{ env: 'OPTIONAL_TOKEN', resource: 'resource://optional', on_failure: 'warn' }],
      mcp_governance: { mode: 'block' },
    })
  })

  it('prefers platform env config over a default XDG runtime profile', () => {
    const xdg = join(root, 'xdg')
    const configDir = join(xdg, 'caracal')
    const profileSecret = join(configDir, 'profile-secret')
    const profileConfig = join(configDir, 'caracal.toml')
    const envSecret = join(root, 'env-secret')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(profileSecret, 'profile-secret\n')
    writeFileSync(profileConfig, [
      'zone_url = "https://profile-sts.example.com"',
      'zone_id = "profile-zone"',
      'application_id = "profile-app"',
      `app_client_secret_file = "${profileSecret}"`,
      '[[credentials]]',
      'env = "PROFILE_TOKEN"',
      'resource = "resource://profile"',
      '',
    ].join('\n'))
    writeFileSync(envSecret, 'env-secret\n')
    if (process.platform !== 'win32') {
      chmodSync(profileSecret, 0o600)
      chmodSync(profileConfig, 0o600)
      chmodSync(envSecret, 0o600)
    }
    process.env.XDG_CONFIG_HOME = xdg
    process.env.CARACAL_STS_URL = 'https://env-sts.example.com'
    process.env.CARACAL_ZONE_ID = 'env-zone'
    process.env.CARACAL_APPLICATION_ID = 'env-app'
    process.env.CARACAL_APP_CLIENT_SECRET_FILE = envSecret
    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify([{ env: 'ENV_TOKEN', resource: 'resource://env' }])

    expect(loadRuntimeConfig(true)).toMatchObject({
      zone_url: 'https://env-sts.example.com',
      zone_id: 'env-zone',
      application_id: 'env-app',
      app_client_secret: 'env-secret',
      credentials: [{ env: 'ENV_TOKEN', resource: 'resource://env' }],
    })
  })

  it('does not treat a Console-only zone env var as runtime config', () => {
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_ZONE_URL = 'https://sts.example.com'

    expect(loadRuntimeConfig(false)).toBeUndefined()
  })

  it('explains when the secret value is put in the secret file path variable', () => {
    process.env.CARACAL_STS_URL = 'https://sts.example.com'
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_APPLICATION_ID = 'app1'
    process.env.CARACAL_APP_CLIENT_SECRET_FILE = 'cs_secret-value'
    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }])

    expect(() => loadRuntimeConfig(true)).toThrow(/secret file path looks like a client secret/)
  })

  it('rejects run TTL values above the resource mandate cap', () => {
    process.env.CARACAL_STS_URL = 'https://sts.example.com'
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_APPLICATION_ID = 'app1'
    process.env.CARACAL_APP_CLIENT_SECRET = 'secret-value'
    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }])
    process.env.CARACAL_RUN_TTL_SECONDS = '901'

    expect(() => loadRuntimeConfig(true)).toThrow(/CARACAL_RUN_TTL_SECONDS must be between 1 and 900/)
  })

  it('rejects unknown runtime config fields', () => {
    const cfg = join(root, 'caracal.toml')
    writeFileSync(cfg, [
      'zone_url = "https://sts.example.com"',
      'zone_id = "zone1"',
      'application_id = "app1"',
      'app_client_secret = "secret-value"',
      'surprise = "nope"',
      '',
    ].join('\n'))
    if (process.platform !== 'win32') chmodSync(cfg, 0o600)
    process.env.CARACAL_CONFIG = cfg

    expect(() => loadRuntimeConfig(true)).toThrow(RuntimeConfigValidationError)
    expect(() => loadRuntimeConfig(true)).toThrow(/unknown runtime config field 'surprise'/)
  })

  it('rejects non-local http endpoints outside development unless explicitly allowed', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_STS_URL = 'http://sts.example.com'
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_APPLICATION_ID = 'app1'
    process.env.CARACAL_APP_CLIENT_SECRET = 'secret-value'
    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }])

    expect(() => loadRuntimeConfig(true)).toThrow(/zone_url must use https outside local development/)

    process.env.CARACAL_ALLOW_INSECURE_CONFIG_URLS = 'true'
    expect(loadRuntimeConfig(true)?.zone_url).toBe('http://sts.example.com')
  })

  it('rejects weakened runtime policy outside development unless explicitly allowed', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_STS_URL = 'https://sts.example.com'
    process.env.CARACAL_ZONE_ID = 'zone1'
    process.env.CARACAL_APPLICATION_ID = 'app1'
    process.env.CARACAL_APP_CLIENT_SECRET = 'secret-value'
    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify({
      credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }],
      continue_on_failure: true,
    })

    expect(() => loadRuntimeConfig(true)).toThrow(/continue_on_failure=true is not allowed outside development/)

    process.env.CARACAL_RUN_CREDENTIALS = JSON.stringify({
      credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }],
      mcp_governance: { mode: 'log' },
    })
    expect(() => loadRuntimeConfig(true)).toThrow(/mcp_governance\.mode=log is not allowed outside development/)

    process.env.CARACAL_ALLOW_MCP_GOVERNANCE_LOG = 'true'
    expect(loadRuntimeConfig(true)?.mcp_governance).toEqual({ mode: 'log' })
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
