// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Preflight diagnostics tests for local service credential discovery.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runPreflightChecks } from '../../../../packages/engine/src/preflight.ts'

const KEY = 'a'.repeat(64)

let cwd: string
let repoRoot: string
let home: string
let servers: Server[] = []
const savedEnv = { ...process.env }

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('server address unavailable'))
      else resolve(address.port)
    })
  })
}

function writeSecrets(dir: string, redisPort: number, redisPassword: string, postgresPort: number): void {
  mkdirSync(dir, { recursive: true })
  for (const file of ['zoneKek', 'auditHmacKey', 'streamsHmacKey', 'gatewayStsHmacKey']) {
    writeFileSync(join(dir, file), `${KEY}\n`)
  }
  writeFileSync(join(dir, 'postgresPassword'), 'postgres-pass\n')
  writeFileSync(join(dir, 'databaseUrl'), `postgres://caracal:postgres-pass@postgres:${postgresPort}/caracal\n`)
  writeFileSync(join(dir, 'redisPassword'), `${redisPassword}\n`)
  writeFileSync(join(dir, 'redisUrl'), `redis://:${redisPassword}@redis:${redisPort}\n`)
}

describe('runPreflightChecks', () => {
  beforeEach(async () => {
    cwd = process.cwd()
    repoRoot = mkdtempSync(join(tmpdir(), 'caracal-preflight-repo-'))
    home = mkdtempSync(join(tmpdir(), 'caracal-preflight-home-'))
    process.chdir(repoRoot)
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n')

    const postgresPort = await listen(createServer((socket) => {
      socket.end()
    }))
    const redisPort = await listen(createServer((socket) => {
      socket.on('data', (chunk) => {
        const command = chunk.toString('utf8')
        socket.end(command.includes('dev-pass') && command.includes('PING')
          ? '+OK\r\n+PONG\r\n'
          : '-WRONGPASS invalid username-password pair or user is disabled.\r\n')
      })
    }))

    writeSecrets(join(home, 'dev-secrets'), redisPort, 'dev-pass', postgresPort)
    writeSecrets(join(home, 'secrets'), redisPort, 'stale-pass', postgresPort)
    process.env = {
      ...savedEnv,
      CARACAL_HOME: home,
      CARACAL_MODE: 'dev',
    }
    delete process.env.CARACAL_REPO_ROOT
    delete process.env.CARACAL_SECRETS_DIR
    process.env.REDIS_URL = 'redis://:stale-pass@127.0.0.1:6379'
    delete process.env.REDIS_URL_FILE
    process.env.REDIS_PASSWORD = 'stale-pass'
    delete process.env.REDIS_PASSWORD_FILE
    process.env.DATABASE_URL = 'postgres://caracal:stale-pass@127.0.0.1:5432/caracal'
    delete process.env.DATABASE_URL_FILE
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    process.env = { ...savedEnv }
    process.chdir(cwd)
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('prefers operator-local dev secrets over stale local env values for dev preflight checks', async () => {
    const checks = await runPreflightChecks()
    const redis = checks.find((check) => check.check === 'Redis')

    expect(redis).toMatchObject({ status: 'ok' })
  })
})

describe('runPreflightChecks failure reporting', () => {
  let cwd: string
  let repoRoot: string
  let home: string
  const saved = { ...process.env }

  beforeEach(() => {
    cwd = process.cwd()
    repoRoot = mkdtempSync(join(tmpdir(), 'caracal-preflight-fail-repo-'))
    home = mkdtempSync(join(tmpdir(), 'caracal-preflight-fail-home-'))
    process.chdir(repoRoot)
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
    process.env = {
      ...saved,
      CARACAL_HOME: home,
      CARACAL_MODE: 'dev',
      DATABASE_URL: 'not a url',
      REDIS_URL: 'not a url',
    }
    delete process.env.CARACAL_REPO_ROOT
    delete process.env.CARACAL_SECRETS_DIR
    delete process.env.STS_URL
  })

  afterEach(() => {
    process.env = { ...saved }
    process.chdir(cwd)
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('reports invalid mode, unreadable secret files, and malformed service URLs deterministically', async () => {
    process.env.CARACAL_MODE = 'broken'
    process.env.ZONE_KEK_FILE = join(home, 'missing-kek')

    const checks = await runPreflightChecks()

    expect(checks.find((check) => check.check === 'CARACAL_MODE')).toMatchObject({ status: 'fail' })
    expect(checks.find((check) => check.check === 'ZONE_KEK')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('ZONE_KEK_FILE unreadable'),
    })
    expect(checks.find((check) => check.check === 'Postgres')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('parse DATABASE_URL'),
    })
    expect(checks.find((check) => check.check === 'Redis')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('parse REDIS_URL'),
    })
  })

  it('reports stable-mode STS and key length failures', async () => {
    process.env.CARACAL_MODE = 'stable'
    process.env.ZONE_KEK = 'aa'
    process.env.AUDIT_HMAC_KEY = 'aa'
    process.env.STREAMS_HMAC_KEY = 'aa'
    process.env.GATEWAY_STS_HMAC_KEY = 'aa'

    const checks = await runPreflightChecks()

    expect(checks.find((check) => check.check === 'CARACAL_MODE')).toMatchObject({
      status: 'fail',
      detail: 'stable mode requires absolute STS_URL',
    })
    expect(checks.find((check) => check.check === 'ZONE_KEK')).toMatchObject({
      status: 'fail',
      detail: 'expected 32 bytes, got 1',
    })
    expect(checks.find((check) => check.check === 'AUDIT_HMAC_KEY')).toMatchObject({
      status: 'fail',
      detail: 'expected at least 32 bytes, got 1',
    })
  })

  it('reports incomplete and unparsable TLS file configuration', async () => {
    const cert = join(home, 'tls.crt')
    const key = join(home, 'tls.key')
    writeFileSync(cert, 'not a certificate', 'utf8')

    process.env.TLS_CERT_FILE = cert
    let checks = await runPreflightChecks()
    expect(checks.find((check) => check.check === 'TLS files')).toMatchObject({
      status: 'fail',
      detail: 'TLS_CERT_FILE and TLS_KEY_FILE must both be set',
    })

    process.env.TLS_KEY_FILE = key
    writeFileSync(key, 'key', 'utf8')
    checks = await runPreflightChecks()
    expect(checks.find((check) => check.check === 'TLS cert')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('parse failed'),
    })
  })
})
