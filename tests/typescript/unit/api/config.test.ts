// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the API service env-file discovery chain.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_PATH = '../../../../apps/api/src/config.ts'

let dir: string
let originalCwd: string
const SAVED_KEYS = [
  'CARACAL_ENV_FILE',
  'CARACAL_REPO_ROOT',
  'CARACAL_HOME',
  'API_TEST_VAR',
  'DATABASE_URL',
  'DATABASE_URL_FILE',
  'REDIS_URL',
  'REDIS_URL_FILE',
  'TRUST_PROXY',
  'API_ENABLE_DOCS',
  'API_OPERATOR_ENABLED',
  'API_OPERATOR_ALLOWED_CAPABILITIES',
  'API_OPERATOR_SYSTEM_ZONES',
  'API_OPERATOR_AI_PROVIDERS',
  'API_OPERATOR_AI_OPENAI_BASE_URL',
  'API_OPERATOR_AI_OPENAI_MODEL',
  'API_OPERATOR_AI_OPENAI_API_KEY',
  'API_OPERATOR_AI_LOCAL_BASE_URL',
  'API_OPERATOR_AI_LOCAL_MODEL',
  'API_MAX_RESOURCES_PER_ZONE',
  'API_READY_OUTBOX_DEAD_MAX',
  'CARACAL_MODE',
  'NODE_ENV',
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-api-cfg-'))
  originalCwd = process.cwd()
  process.chdir(dir)
  for (const k of SAVED_KEYS) delete process.env[k]
  vi.resetModules()
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
  for (const k of SAVED_KEYS) delete process.env[k]
})

describe('api config loadEnvChain', () => {
  test('does not load cwd .env in production-like mode', async () => {
    writeFileSync(join(dir, '.env'), 'API_TEST_VAR=cwd-leak\n')
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBeUndefined()
  })

  test('loads CARACAL_ENV_FILE when explicit', async () => {
    const envPath = join(dir, 'explicit.env')
    writeFileSync(envPath, 'API_TEST_VAR=explicit-value\n')
    process.env.CARACAL_ENV_FILE = envPath
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBe('explicit-value')
  })

  test('loads infra/docker/dev.env when CARACAL_REPO_ROOT is set in dev mode', async () => {
    mkdirSync(join(dir, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(dir, 'infra', 'docker', 'dev.env'), 'API_TEST_VAR=repo-value\n')
    process.env.CARACAL_MODE = 'dev'
    process.env.CARACAL_REPO_ROOT = dir
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBe('repo-value')
  })

  test('local.env overrides dev.env in dev mode', async () => {
    mkdirSync(join(dir, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(dir, 'infra', 'docker', 'dev.env'), 'API_TEST_VAR=dev-default\n')
    writeFileSync(join(dir, 'infra', 'docker', 'local.env'), 'API_TEST_VAR=local-override\n')
    process.env.CARACAL_MODE = 'dev'
    process.env.CARACAL_REPO_ROOT = dir
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBe('local-override')
  })

  test('does not load repo env files in stable mode', async () => {
    mkdirSync(join(dir, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(dir, 'infra', 'docker', 'dev.env'), 'API_TEST_VAR=stable-leak\n')
    process.env.CARACAL_MODE = 'stable'
    process.env.CARACAL_REPO_ROOT = dir
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBeUndefined()
  })

  test('loads installed operator env file in stable mode', async () => {
    mkdirSync(join(dir, 'home'), { recursive: true })
    writeFileSync(join(dir, 'home', 'caracal.env'), 'API_TEST_VAR=installed-value\n')
    process.env.CARACAL_MODE = 'stable'
    process.env.CARACAL_HOME = join(dir, 'home')

    await import(CONFIG_PATH)

    expect(process.env.API_TEST_VAR).toBe('installed-value')
  })

  test('explicit env file wins over installed operator env file', async () => {
    mkdirSync(join(dir, 'home'), { recursive: true })
    const explicit = join(dir, 'explicit.env')
    writeFileSync(explicit, 'API_TEST_VAR=explicit-value\n')
    writeFileSync(join(dir, 'home', 'caracal.env'), 'API_TEST_VAR=installed-value\n')
    process.env.CARACAL_MODE = 'stable'
    process.env.CARACAL_HOME = join(dir, 'home')
    process.env.CARACAL_ENV_FILE = explicit

    await import(CONFIG_PATH)

    expect(process.env.API_TEST_VAR).toBe('explicit-value')
  })

  test('does not walk up from cwd looking for infra/docker/dev.env', async () => {
    const sub = join(dir, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(dir, 'infra', 'docker'), { recursive: true })
    writeFileSync(join(dir, 'infra', 'docker', 'dev.env'), 'API_TEST_VAR=walked-up\n')
    process.chdir(sub)
    await import(CONFIG_PATH)
    expect(process.env.API_TEST_VAR).toBeUndefined()
  })
})

describe('api config trustProxy', () => {
  const REQ = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    REDIS_URL: 'redis://:r@localhost:6379',
  }
  beforeEach(() => {
    for (const [k, v] of Object.entries(REQ)) process.env[k] = v
  })
  afterEach(() => {
    for (const k of Object.keys(REQ)) delete process.env[k]
  })

  test('defaults to false when TRUST_PROXY unset', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    expect(loadConfig().trustProxy).toBe(false)
  })

  test('parses TRUST_PROXY=true', async () => {
    process.env.TRUST_PROXY = 'true'
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    expect(loadConfig().trustProxy).toBe(true)
  })

  test('resolves required database and redis URLs from secret files', async () => {
    const databaseFile = join(dir, 'databaseUrl')
    const redisFile = join(dir, 'redisUrl')
    writeFileSync(databaseFile, 'postgres://file\n')
    writeFileSync(redisFile, 'redis://file\n')
    delete process.env.DATABASE_URL
    delete process.env.REDIS_URL
    process.env.DATABASE_URL_FILE = databaseFile
    process.env.REDIS_URL_FILE = redisFile

    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    const cfg = loadConfig()

    expect(cfg.databaseUrl).toBe('postgres://file')
    expect(cfg.redisUrl).toBe('redis://file')
    expect(process.env.DATABASE_URL_FILE).toBeUndefined()
    expect(process.env.REDIS_URL_FILE).toBeUndefined()
  })

  test('rejects invalid boolean values', async () => {
    process.env.API_ENABLE_DOCS = 'maybe'
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')

    expect(() => loadConfig()).toThrow('Invalid boolean env var API_ENABLE_DOCS')
  })

  test('defaults enableDocs off in published builds and on in dev', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    process.env.CARACAL_MODE = 'stable'
    expect(loadConfig().enableDocs).toBe(false)
    process.env.CARACAL_MODE = 'dev'
    expect(loadConfig().enableDocs).toBe(true)
    process.env.API_ENABLE_DOCS = 'true'
    process.env.CARACAL_MODE = 'stable'
    expect(loadConfig().enableDocs).toBe(true)
    delete process.env.API_ENABLE_DOCS
    delete process.env.CARACAL_MODE
  })

  test('operator is enabled by default and disabled only when explicitly turned off', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    expect(loadConfig().operatorEnabled).toBe(true)
    process.env.API_OPERATOR_ENABLED = 'false'
    expect(loadConfig().operatorEnabled).toBe(false)
    delete process.env.API_OPERATOR_ENABLED
  })

  test('parses operator authority lists, defaulting the grant to null and zones to empty', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    let cfg = loadConfig()
    expect(cfg.operatorAllowedCapabilities).toBeNull()
    expect(cfg.operatorSystemZones).toEqual([])

    process.env.API_OPERATOR_ALLOWED_CAPABILITIES = 'createZone, registerApplication'
    process.env.API_OPERATOR_SYSTEM_ZONES = 'sys-ops,sys-audit'
    cfg = loadConfig()
    expect(cfg.operatorAllowedCapabilities).toEqual(['createZone', 'registerApplication'])
    expect(cfg.operatorSystemZones).toEqual(['sys-ops', 'sys-audit'])
    delete process.env.API_OPERATOR_ALLOWED_CAPABILITIES
    delete process.env.API_OPERATOR_SYSTEM_ZONES
  })

  test('AI providers default to empty and parse an ordered failover list with optional keys', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    expect(loadConfig().operatorAiProviders).toEqual([])

    process.env.API_OPERATOR_AI_PROVIDERS = 'openai, local'
    process.env.API_OPERATOR_AI_OPENAI_BASE_URL = 'https://api.openai.com/v1/'
    process.env.API_OPERATOR_AI_OPENAI_MODEL = 'gpt-4o-mini'
    process.env.API_OPERATOR_AI_OPENAI_API_KEY = 'sk-test'
    process.env.API_OPERATOR_AI_LOCAL_BASE_URL = 'http://localhost:11434/v1'
    process.env.API_OPERATOR_AI_LOCAL_MODEL = 'llama3'
    const providers = loadConfig().operatorAiProviders
    expect(providers).toEqual([
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test', timeoutMs: 30000 },
      { id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama3', apiKey: undefined, timeoutMs: 30000 },
    ])
    delete process.env.API_OPERATOR_AI_PROVIDERS
    delete process.env.API_OPERATOR_AI_OPENAI_BASE_URL
    delete process.env.API_OPERATOR_AI_OPENAI_MODEL
    delete process.env.API_OPERATOR_AI_OPENAI_API_KEY
    delete process.env.API_OPERATOR_AI_LOCAL_BASE_URL
    delete process.env.API_OPERATOR_AI_LOCAL_MODEL
  })

  test('a configured AI provider missing its base URL or model fails closed', async () => {
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    process.env.API_OPERATOR_AI_PROVIDERS = 'openai'
    process.env.API_OPERATOR_AI_OPENAI_MODEL = 'gpt-4o-mini'
    expect(() => loadConfig()).toThrow(/BASE_URL and _MODEL/)
    delete process.env.API_OPERATOR_AI_PROVIDERS
    delete process.env.API_OPERATOR_AI_OPENAI_MODEL
  })

  test('rejects a gateway STS HMAC key shorter than 32 bytes', async () => {
    process.env.GATEWAY_STS_HMAC_KEY = 'abcd'
    const { loadConfig } = (await import(CONFIG_PATH)) as typeof import('../../../../apps/api/src/config')
    expect(() => loadConfig()).toThrow('GATEWAY_STS_HMAC_KEY must be hex-encoded with at least 32 bytes')
    delete process.env.GATEWAY_STS_HMAC_KEY
  })
})
