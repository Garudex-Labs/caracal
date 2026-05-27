// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Local preflight checks shared by Console diagnostics and runtime automation.

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { discoverRepoRoot, installedHome } from '@caracalai/core'

export interface PreflightCheck {
  check: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

const KEY_MIN_BYTES = 32
const TLS_EXPIRY_WARN_DAYS = 30
const TCP_TIMEOUT_MS = 5000
const SECRET_FILES: Record<string, string> = {
  ZONE_KEK: 'zoneKek',
  AUDIT_HMAC_KEY: 'auditHmacKey',
  STREAMS_HMAC_KEY: 'streamsHmacKey',
  GATEWAY_STS_HMAC_KEY: 'gatewayStsHmacKey',
  POSTGRES_PASSWORD: 'postgresPassword',
  REDIS_PASSWORD: 'redisPassword',
  CARACAL_COORDINATOR_TOKEN: 'caracalCoordinatorToken',
  DATABASE_URL: 'databaseUrl',
  REDIS_URL: 'redisUrl',
}

interface ResolvedValue {
  value: string
  source: 'env' | 'file' | 'managed'
}

function readSecret(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const value = readFileSync(path, 'utf8').trim()
  return value.length > 0 ? value : undefined
}

function secretDirs(): string[] {
  const root = discoverRepoRoot()
  const devDir = root ? join(root, 'infra', 'secrets', 'files') : undefined
  const installedDir = join(installedHome(), 'secrets')
  const preferDev = process.env.CARACAL_MODE === 'dev' || (!process.env.CARACAL_HOME && root !== undefined)
  const generatedDirs = preferDev ? [devDir, installedDir] : [installedDir, devDir]
  const dirs = [
    process.env.CARACAL_SECRETS_DIR,
    ...generatedDirs,
  ].filter((dir): dir is string => Boolean(dir))
  return [...new Set(dirs)]
}

function managedSecret(name: string): ResolvedValue | undefined {
  const fileName = SECRET_FILES[name]
  if (!fileName) return undefined
  for (const dir of secretDirs()) {
    const value = readSecret(join(dir, fileName))
    if (value) return { value, source: 'managed' }
  }
  return undefined
}

function explicitValue(name: string): ResolvedValue | undefined {
  const direct = process.env[name]
  if (direct) return { value: direct, source: 'env' }
  const filePath = process.env[`${name}_FILE`]
  if (filePath) {
    try {
      const value = readSecret(filePath)
      if (!value) throw new Error('empty secret file')
      return { value, source: 'file' }
    } catch (err) {
      throw new Error(`${name}_FILE unreadable: ${(err as Error).message}`)
    }
  }
  return undefined
}

function fileBacked(name: string): ResolvedValue | undefined {
  return explicitValue(name) ?? managedSecret(name)
}

function localServiceUrl(name: string, internalHost: string): ResolvedValue | undefined {
  const explicit = explicitValue(name)
  const managed = managedSecret(name)
  if (managed && preferManagedLocalUrl(explicit, internalHost)) {
    const url = new URL(managed.value)
    url.hostname = '127.0.0.1'
    return { value: url.toString(), source: 'managed' }
  }
  return explicit ?? managed
}

function preferManagedLocalUrl(explicit: ResolvedValue | undefined, internalHost: string): boolean {
  if (!explicit) return true
  if (process.env.CARACAL_MODE === 'dev') return true
  try {
    const host = new URL(explicit.value).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === internalHost
  } catch {
    return false
  }
}

function localPostgresUrl(): ResolvedValue | undefined {
  const explicit = localServiceUrl('DATABASE_URL', 'postgres')
  if (explicit) return explicit
  const password = fileBacked('POSTGRES_PASSWORD') ?? managedSecret('POSTGRES_PASSWORD')
  if (!password) return undefined
  const user = process.env.POSTGRES_USER ?? 'caracal'
  const db = process.env.POSTGRES_DB ?? 'caracal'
  const url = new URL('postgres://127.0.0.1:5432')
  url.username = user
  url.password = password.value
  url.pathname = `/${db}`
  return { value: url.toString(), source: 'managed' }
}

function localRedisUrl(): ResolvedValue | undefined {
  const explicit = localServiceUrl('REDIS_URL', 'redis')
  if (explicit) return explicit
  const password = fileBacked('REDIS_PASSWORD') ?? managedSecret('REDIS_PASSWORD')
  if (!password) return undefined
  const url = new URL('redis://127.0.0.1:6379')
  url.password = password.value
  return { value: url.toString(), source: 'managed' }
}

function sourceSuffix(value: ResolvedValue): string {
  return value.source === 'managed' ? ' (auto-discovered)' : ''
}

function decodeKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex')
  return Buffer.from(raw, 'base64')
}

function checkMode(): PreflightCheck {
  const mode = process.env.CARACAL_MODE ?? 'dev'
  if (mode !== 'dev' && mode !== 'rc' && mode !== 'stable') {
    return { check: 'CARACAL_MODE', status: 'fail', detail: `unknown mode "${mode}"; expected dev | rc | stable` }
  }
  if (mode === 'stable') {
    const stsUrl = process.env.STS_URL ?? ''
    try {
      const u = new URL(stsUrl)
      if (!u.host) throw new Error('missing host')
    } catch {
      return { check: 'CARACAL_MODE', status: 'fail', detail: 'stable mode requires absolute STS_URL' }
    }
  }
  return { check: 'CARACAL_MODE', status: 'ok', detail: mode }
}

function checkKey(name: string, expectedBytes: number, exact: boolean): PreflightCheck {
  let raw: ResolvedValue | undefined
  try {
    raw = fileBacked(name)
  } catch (err) {
    return { check: name, status: 'fail', detail: (err as Error).message }
  }
  if (!raw) return { check: name, status: 'fail', detail: 'not set' }
  let key: Buffer
  try {
    key = decodeKey(raw.value)
  } catch (err) {
    return { check: name, status: 'fail', detail: `decode failed: ${(err as Error).message}` }
  }
  if (exact && key.length !== expectedBytes) {
    return { check: name, status: 'fail', detail: `expected ${expectedBytes} bytes, got ${key.length}` }
  }
  if (!exact && key.length < expectedBytes) {
    return { check: name, status: 'fail', detail: `expected at least ${expectedBytes} bytes, got ${key.length}` }
  }
  return { check: name, status: 'ok', detail: `${key.length} bytes${sourceSuffix(raw)}` }
}

function checkTLS(): PreflightCheck[] {
  const mode = process.env.CARACAL_MODE ?? 'dev'
  const cert = process.env.TLS_CERT_FILE
  const key = process.env.TLS_KEY_FILE
  if (!cert && !key) {
    if (mode === 'dev') return [{ check: 'TLS files', status: 'ok', detail: 'not required in dev mode' }]
    return [{ check: 'TLS files', status: 'warn', detail: 'not configured; terminate TLS at the edge or set TLS_CERT_FILE/TLS_KEY_FILE' }]
  }
  if (!cert || !key) return [{ check: 'TLS files', status: 'fail', detail: 'TLS_CERT_FILE and TLS_KEY_FILE must both be set' }]
  let pem: string
  try {
    pem = readFileSync(cert, 'utf8')
  } catch (err) {
    return [{ check: 'TLS cert', status: 'fail', detail: `${cert}: ${(err as Error).message}` }]
  }
  try {
    readFileSync(key, 'utf8')
  } catch (err) {
    return [{ check: 'TLS key', status: 'fail', detail: `${key}: ${(err as Error).message}` }]
  }
  let x509: X509Certificate
  try {
    x509 = new X509Certificate(pem)
  } catch (err) {
    return [{ check: 'TLS cert', status: 'fail', detail: `parse failed: ${(err as Error).message}` }]
  }
  const expiry = new Date(x509.validTo)
  const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  if (daysLeft < 0) return [{ check: 'TLS cert', status: 'fail', detail: `expired ${-daysLeft} day(s) ago` }]
  if (daysLeft < TLS_EXPIRY_WARN_DAYS) return [{ check: 'TLS cert', status: 'warn', detail: `expires in ${daysLeft} day(s)` }]
  return [{ check: 'TLS cert', status: 'ok', detail: `${x509.subject}; ${daysLeft} day(s) until expiry` }]
}

async function tcpProbe(name: string, host: string, port: number, hello?: { send: Buffer; expectPrefix?: Buffer; expectContains?: Buffer }): Promise<PreflightCheck> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: TCP_TIMEOUT_MS })
    let settled = false
    let received = Buffer.alloc(0)
    const finish = (result: PreflightCheck) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.on('error', (err) => finish({ check: name, status: 'fail', detail: `${host}:${port} ${err.message}` }))
    socket.on('timeout', () => finish({ check: name, status: 'fail', detail: `${host}:${port} timeout after ${TCP_TIMEOUT_MS}ms` }))
    socket.on('connect', () => {
      if (!hello) return finish({ check: name, status: 'ok', detail: `${host}:${port} reachable` })
      socket.write(hello.send)
    })
    socket.on('data', (chunk) => {
      if (!hello) return
      received = Buffer.concat([received, chunk])
      const matchedPrefix = hello.expectPrefix && received.subarray(0, hello.expectPrefix.length).equals(hello.expectPrefix)
      const matchedContent = hello.expectContains && received.includes(hello.expectContains)
      if (matchedPrefix || matchedContent) {
        finish({ check: name, status: 'ok', detail: `${host}:${port} responded` })
      } else {
        const text = received.toString('utf8')
        if (text.startsWith('-')) finish({ check: name, status: 'fail', detail: `${host}:${port} unexpected response: ${text.slice(0, 60)}` })
      }
    })
  })
}

function redisCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`
}

async function checkPostgres(): Promise<PreflightCheck> {
  let raw: ResolvedValue | undefined
  try {
    raw = localPostgresUrl()
  } catch (err) {
    return { check: 'Postgres', status: 'fail', detail: (err as Error).message }
  }
  if (!raw) return { check: 'Postgres', status: 'fail', detail: 'DATABASE_URL not set' }
  let host: string
  let port: number
  try {
    const u = new URL(raw.value)
    host = u.hostname
    port = u.port ? Number(u.port) : 5432
  } catch (err) {
    return { check: 'Postgres', status: 'fail', detail: `parse DATABASE_URL: ${(err as Error).message}` }
  }
  const result = await tcpProbe('Postgres', host, port)
  return result.status === 'ok' ? { ...result, detail: `${result.detail}${sourceSuffix(raw)}` } : result
}

async function checkRedis(): Promise<PreflightCheck> {
  let raw: ResolvedValue | undefined
  try {
    raw = localRedisUrl()
  } catch (err) {
    return { check: 'Redis', status: 'fail', detail: (err as Error).message }
  }
  if (!raw) return { check: 'Redis', status: 'fail', detail: 'REDIS_URL not set' }
  let host: string
  let port: number
  let username: string | undefined
  let password: string | undefined
  try {
    const u = new URL(raw.value)
    host = u.hostname
    port = u.port ? Number(u.port) : 6379
    username = u.username ? decodeURIComponent(u.username) : undefined
    password = u.password ? decodeURIComponent(u.password) : undefined
  } catch (err) {
    return { check: 'Redis', status: 'fail', detail: `parse REDIS_URL: ${(err as Error).message}` }
  }
  const auth = password ? redisCommand(username ? ['AUTH', username, password] : ['AUTH', password]) : ''
  const result = await tcpProbe('Redis', host, port, {
    send: Buffer.from(`${auth}${redisCommand(['PING'])}`),
    expectPrefix: password ? undefined : Buffer.from('+PONG'),
    expectContains: password ? Buffer.from('+PONG') : undefined,
  })
  return result.status === 'ok' ? { ...result, detail: `${result.detail}${sourceSuffix(raw)}` } : result
}

export async function runPreflightChecks(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  checks.push(checkMode())
  checks.push(checkKey('ZONE_KEK', 32, true))
  checks.push(checkKey('AUDIT_HMAC_KEY', KEY_MIN_BYTES, false))
  checks.push(checkKey('STREAMS_HMAC_KEY', KEY_MIN_BYTES, false))
  checks.push(checkKey('GATEWAY_STS_HMAC_KEY', KEY_MIN_BYTES, false))
  checks.push(...checkTLS())
  checks.push(await checkPostgres())
  checks.push(await checkRedis())
  return checks
}
