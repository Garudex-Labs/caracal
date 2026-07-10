// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for workload identity loading, secret file handling, and production service URL strictness.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_API_URL,
  DEFAULT_STS_URL,
  RuntimeConfigMissingError,
  RuntimeConfigValidationError,
  ServiceUrlMissingError,
  assertCredentialEnvName,
  defaultWorkloadSecretFilePath,
  loadRuntimeIdentity,
  resolveServiceUrl,
} from '../../../../packages/engine/src/runtimeConfig.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caracal-rtcfg-'))
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-default')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.CARACAL_STS_URL
  delete process.env.CARACAL_ZONE_URL
  delete process.env.CARACAL_WORKLOAD_ID
  delete process.env.CARACAL_WORKLOAD_SECRET
  delete process.env.CARACAL_WORKLOAD_SECRET_FILE
  delete process.env.CARACAL_ALLOW_INSECURE_CONFIG_URLS
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CARACAL_API_URL
  delete process.env.NODE_ENV
  delete process.env.CARACAL_ENV
})

function writeSecretFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
  chmodSync(path, 0o600)
}

describe('loadRuntimeIdentity', () => {
  it('returns undefined when no workload id is set and identity is optional', () => {
    expect(loadRuntimeIdentity(false)).toBeUndefined()
  })

  it('throws RuntimeConfigMissingError when identity is required but absent', () => {
    expect(() => loadRuntimeIdentity(true)).toThrow(RuntimeConfigMissingError)
    expect(() => loadRuntimeIdentity(true)).toThrow(/CARACAL_WORKLOAD_ID/)
  })

  it('loads the identity from environment variables', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    expect(loadRuntimeIdentity(true)).toEqual({
      sts_url: DEFAULT_STS_URL,
      workload_id: 'wl1',
      workload_secret: 'ws_secret',
    })
  })

  it('reads the secret from an explicit secret file', () => {
    const secretPath = join(root, 'secret')
    writeSecretFile(secretPath, 'ws_from_file\n')
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = secretPath
    expect(loadRuntimeIdentity(true)).toMatchObject({ workload_secret: 'ws_from_file' })
  })

  it('auto-detects the owner-only default secret file outside production', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    const secretPath = defaultWorkloadSecretFilePath('wl1')
    writeSecretFile(secretPath, 'ws_local')
    expect(loadRuntimeIdentity(true)).toMatchObject({ workload_secret: 'ws_local' })
  })

  it('sanitizes the workload id into the default secret path', () => {
    process.env.CARACAL_WORKLOAD_ID = '  wl/value  '
    const secretPath = defaultWorkloadSecretFilePath('  wl/value  ')
    expect(secretPath).not.toContain('/value')
    writeSecretFile(secretPath, 'ws_local')
    expect(loadRuntimeIdentity(true)).toMatchObject({ workload_secret: 'ws_local' })
  })

  it('ignores the default secret file in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_STS_URL = 'https://sts.pipernet.example'
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    const secretPath = defaultWorkloadSecretFilePath('wl1')
    writeSecretFile(secretPath, 'ws_local')
    expect(() => loadRuntimeIdentity(true)).toThrow(/workload secret is required/)
  })

  it('honors CARACAL_ENV=production for the default secret file gate', () => {
    process.env.CARACAL_ENV = 'production'
    process.env.CARACAL_STS_URL = 'https://sts.pipernet.example'
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    const secretPath = defaultWorkloadSecretFilePath('wl1')
    writeSecretFile(secretPath, 'ws_local')
    expect(() => loadRuntimeIdentity(true)).toThrow(/workload secret is required/)
  })

  it('lets CARACAL_ENV override a production NODE_ENV', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_ENV = 'development'
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    const secretPath = defaultWorkloadSecretFilePath('wl1')
    writeSecretFile(secretPath, 'ws_local')
    expect(loadRuntimeIdentity(true)).toMatchObject({ workload_secret: 'ws_local' })
  })

  it('fails when the workload id is set but no secret source exists', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    expect(() => loadRuntimeIdentity(true)).toThrow(/workload secret is required/)
    expect(() => loadRuntimeIdentity(true)).toThrow(RuntimeConfigValidationError)
  })

  it('rejects setting both the inline secret and the secret file', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = join(root, 'secret')
    expect(() => loadRuntimeIdentity(true)).toThrow(/set only one of/)
  })

  it('rejects a secret file path that looks like a workload secret', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = 'ws_pasted_secret_value'
    expect(() => loadRuntimeIdentity(true)).toThrow(/looks like a workload secret/)
  })

  // Mode-bit enforcement is POSIX-only; the runtime skips the check on Windows.
  it.runIf(process.platform !== 'win32')('rejects a group-writable secret file', () => {
    const secretPath = join(root, 'secret')
    writeSecretFile(secretPath, 'ws_from_file')
    chmodSync(secretPath, 0o660)
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = secretPath
    expect(() => loadRuntimeIdentity(true)).toThrow(/permissions are too broad/)
  })

  it.runIf(process.platform !== 'win32')('rejects a group- or world-readable secret file', () => {
    const secretPath = join(root, 'secret')
    writeSecretFile(secretPath, 'ws_from_file')
    chmodSync(secretPath, 0o640)
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = secretPath
    expect(() => loadRuntimeIdentity(true)).toThrow(/owner-only/)
    chmodSync(secretPath, 0o604)
    expect(() => loadRuntimeIdentity(true)).toThrow(/permissions are too broad/)
  })

  it('rejects an empty secret file', () => {
    const secretPath = join(root, 'secret')
    writeSecretFile(secretPath, '   \n')
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET_FILE = secretPath
    expect(() => loadRuntimeIdentity(true)).toThrow(/secret file is empty/)
  })

  it('honors CARACAL_STS_URL for the STS endpoint', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    process.env.CARACAL_STS_URL = 'https://sts.pipernet.example'
    expect(loadRuntimeIdentity(true)).toMatchObject({ sts_url: 'https://sts.pipernet.example' })
  })

  it('rejects a plain-http STS URL for non-local hosts in every environment', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    process.env.CARACAL_STS_URL = 'http://sts.pipernet.example'
    expect(() => loadRuntimeIdentity(true)).toThrow(/must use https for non-local hosts/)
    process.env.NODE_ENV = 'production'
    expect(() => loadRuntimeIdentity(true)).toThrow(/must use https for non-local hosts/)
  })

  it('allows plain-http for non-local hosts only with the explicit insecure override', () => {
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    process.env.CARACAL_STS_URL = 'http://sts.pipernet.example'
    process.env.CARACAL_ALLOW_INSECURE_CONFIG_URLS = 'true'
    expect(loadRuntimeIdentity(true)).toMatchObject({ sts_url: 'http://sts.pipernet.example' })
  })

  it('requires an explicit STS URL outside development', () => {
    process.env.NODE_ENV = 'production'
    process.env.CARACAL_WORKLOAD_ID = 'wl1'
    process.env.CARACAL_WORKLOAD_SECRET = 'ws_secret'
    expect(() => loadRuntimeIdentity(true)).toThrow(ServiceUrlMissingError)
  })
})

describe('assertCredentialEnvName', () => {
  it('accepts a well-formed env name', () => {
    expect(() => assertCredentialEnvName('CARACAL_RESOURCE_PIPERNET_TOKEN')).not.toThrow()
  })

  it('rejects malformed env names', () => {
    expect(() => assertCredentialEnvName('9BAD')).toThrow(RuntimeConfigValidationError)
    expect(() => assertCredentialEnvName('BAD-NAME')).toThrow(/invalid credential env/)
  })

  it('rejects loader-hijack env names', () => {
    expect(() => assertCredentialEnvName('LD_PRELOAD')).toThrow(/blocked credential env/)
    expect(() => assertCredentialEnvName('NODE_OPTIONS')).toThrow(/blocked credential env/)
    expect(() => assertCredentialEnvName('ld_preload')).toThrow(/blocked credential env/)
    expect(() => assertCredentialEnvName('Node_Options')).toThrow(/blocked credential env/)
  })
})

describe('resolveServiceUrl', () => {
  it('returns the dev default in development', () => {
    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe(DEFAULT_API_URL)
  })

  it('prefers the environment override', () => {
    process.env.CARACAL_API_URL = 'https://api.pipernet.example'
    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe('https://api.pipernet.example')
  })

  it('throws outside development when the env var is missing', () => {
    process.env.NODE_ENV = 'production'
    expect(() => resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toThrow(ServiceUrlMissingError)
  })

  it('honors CARACAL_ENV over NODE_ENV', () => {
    process.env.CARACAL_ENV = 'production'
    expect(() => resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toThrow(ServiceUrlMissingError)
    process.env.CARACAL_ENV = 'development'
    process.env.NODE_ENV = 'production'
    expect(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)).toBe(DEFAULT_API_URL)
  })
})
