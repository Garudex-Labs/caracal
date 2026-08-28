// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared boot-level harness for governed Operator integration tests. It keeps the API and
// Postgres real while replacing only the separately deployed STS, Coordinator, Gateway, and
// model upstream with small HTTP protocol fakes. Full-lifecycle tests can reuse the same boot
// boundary without copying the system-zone provisioning setup.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { buildApp } from '../../../../apps/api/src/app.js'
import { seedBootstrapAdminToken } from '../../../../apps/api/src/auth.js'
import type { Config } from '../../../../apps/api/src/config.js'
import { newDB, scopedDB } from '../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'
import { llmResourceIdentifier } from '../../../../apps/api/src/system-zone.js'

const PROVIDER_ID = 'boot-e2e'
const MODEL = 'operator-test-model'
const UPSTREAM_KEY = 'upstream-key-must-stay-sealed'
const ADMIN_TOKEN = 'governed-operator-boot-admin-token'

interface HttpFixture {
  url: string
  close: () => Promise<void>
}

export interface GovernedGatewayCall {
  authorization: string | null
  resource: string | null
  baggage: string | null
  path: string
  body: string
}

export interface GovernedUpstreamCall {
  authorization: string | null
  path: string
  body: string
}

export interface StsExchange {
  scope: string
  zoneId: string | null
  applicationId: string | null
}

export interface GovernedOperatorHarness {
  app: FastifyInstance
  apiUrl: string
  adminToken: string
  pool: pg.Pool
  providerId: string
  model: string
  upstreamKey: string
  resourceIdentifier: string
  sessionIds: string[]
  stsScopes: string[]
  stsExchanges: StsExchange[]
  gatewayCalls: GovernedGatewayCall[]
  upstreamCalls: GovernedUpstreamCall[]
  close: () => Promise<void>
}

function json(reply: ServerResponse, status: number, body: unknown): void {
  reply.writeHead(status, { 'content-type': 'application/json' })
  reply.end(JSON.stringify(body))
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function startHttpFixture(handler: (request: IncomingMessage, reply: ServerResponse) => void | Promise<void>): Promise<HttpFixture> {
  const server = createServer((request, reply) => {
    void Promise.resolve(handler(request, reply)).catch((error: unknown) => {
      if (reply.headersSent) {
        reply.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      json(reply, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
      }
      return closing
    },
  }
}

function copyRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || name === 'connection' || name === 'content-length' || name === 'transfer-encoding') continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

async function waitForGovernedExecution(apiUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastBody = ''
  while (Date.now() < deadline) {
    const response = await fetch(`${apiUrl}/v1/operator/status`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    lastBody = await response.text()
    if (response.ok) {
      const status = JSON.parse(lastBody) as { governed_execution?: { configured?: boolean } }
      if (status.governed_execution?.configured === true) return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`governed Operator did not finish boot provisioning: ${lastBody}`)
}

function makeRedis(): RedisClient {
  const values = new Map<string, string>()
  const counters = new Map<string, number>()
  return {
    incr: async (key: string) => {
      const value = (counters.get(key) ?? 0) + 1
      counters.set(key, value)
      return value
    },
    expire: async () => 1,
    set: async (key: string, value: string) => {
      values.set(key, value)
      return 'OK'
    },
    get: async (key: string) => values.get(key) ?? null,
    del: async (key: string) => (values.delete(key) ? 1 : 0),
    ping: async () => 'PONG',
    eval: async () => 0,
  } as unknown as RedisClient
}

function makeConfig(
  databaseUrl: string,
  services: { sts: string; coordinator: string; gateway: string; upstream: string; api: string },
): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl,
    redisUrl: 'redis://unused.test',
    stsUrl: services.sts,
    gatewayUrl: services.gateway,
    coordinatorUrl: services.coordinator,
    gatewayStsHmacKey: null,
    auditHmacKey: null,
    logLevel: process.env.CARACAL_TEST_LOG_LEVEL ?? 'fatal',
    bootstrapAdminToken: ADMIN_TOKEN,
    shutdownGraceMs: 5_000,
    workerId: 'operator-governed-boot-e2e',
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 30_000,
    keepAliveTimeoutMs: 75_000,
    auditRetentionMaxDays: 365,
    stsMintRateLimitPerMin: 1_000,
    db: {
      poolMax: 8,
      statementTimeoutMs: 15_000,
      idleInTxTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
    },
    outbox: { pollIntervalMs: 100, batchSize: 8, lockDurationSec: 30, maxAttempts: 5, streamMaxLen: 1_000 },
    readyRateLimitPerMin: 0,
    v1RateLimitPerMin: 0,
    adminAuthFailLimitPerMin: 0,
    lastUsedDebounceSec: 0,
    maxResourcesPerZone: 100_000,
    readyOutboxDeadMax: 0,
    trustProxy: false,
    enableDocs: false,
    operatorEnabled: true,
    operatorAllowedCapabilities: null,
    operatorSystemZones: [],
    operatorAiProviders: [
      {
        id: PROVIDER_ID,
        baseUrl: `${services.upstream}/v1`,
        model: MODEL,
        apiKey: UPSTREAM_KEY,
        timeoutMs: 5_000,
        contextWindow: 8_192,
      },
    ],
    operatorMaxConcurrentRunsPerUser: 2,
    operatorAutopilotEnabled: false,
    operatorAutopilotWriteBudget: 0,
    operatorAiMaxOutputTokens: 4_096,
    operatorAiMaxCallsPerTurn: 12,
    metricsBearer: null,
    control: {
      jwksUrl: `${services.sts}/.well-known/jwks.json`,
      issuer: services.sts,
      audience: 'caracal-control',
      apiUrl: services.api,
      apiToken: ADMIN_TOKEN,
      rateCapacity: 60,
      rateWindowSec: 60,
      ipRateLimitPerMin: 0,
      replayTtlSec: 3_600,
      gateFile: undefined,
    },
  }
}

export async function startGovernedOperatorHarness(databaseUrl: string): Promise<GovernedOperatorHarness> {
  const fixtures: HttpFixture[] = []
  let app: FastifyInstance | undefined
  let pool: pg.Pool | undefined
  const stsScopes: string[] = []
  const stsExchanges: StsExchange[] = []
  const gatewayCalls: GovernedGatewayCall[] = []
  const upstreamCalls: GovernedUpstreamCall[] = []
  const sessionIds: string[] = []
  let session = 0
  let mandate = 0
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        const errors: unknown[] = []
        const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
          try {
            await operation()
          } catch (error) {
            errors.push(error)
          }
        }
        const activeApp = app
        const activePool = pool
        if (activeApp) {
          await attempt(async () => {
            // The test uses Node's global fetch, whose pooled keep-alive sockets can outlive
            // the assertions (notably on Node 24). Begin Fastify shutdown first, then close
            // those test-only connections so teardown does not wait for their idle timeout.
            const appClosing = activeApp.close()
            activeApp.server.closeAllConnections()
            await appClosing
          })
        }
        if (activePool) await attempt(() => activePool.end())
        for (const fixture of [...fixtures].reverse()) await attempt(fixture.close)
        if (errors.length) throw new AggregateError(errors, 'governed Operator harness teardown failed')
      })()
    }
    return closing
  }

  try {
    const upstream = await startHttpFixture(async (request, reply) => {
      const body = await requestBody(request)
      upstreamCalls.push({ authorization: request.headers.authorization ?? null, path: request.url ?? '', body })
      json(reply, 200, {
        id: 'chatcmpl-operator-boot',
        object: 'chat.completion',
        created: 1,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })
    })
    fixtures.push(upstream)

    const authority = await startHttpFixture(async (request, reply) => {
      const method = request.method ?? 'GET'
      const path = request.url ?? ''
      const body = await requestBody(request)
      if (method === 'POST' && path === '/oauth/2/token') {
        const form = new URLSearchParams(body)
        const scope = form.get('scope') ?? ''
        stsScopes.push(scope)
        stsExchanges.push({ scope, zoneId: form.get('zone_id'), applicationId: form.get('application_id') })
        if (!form.get('client_secret')?.startsWith('cs_')) {
          return json(reply, 401, { error: 'invalid_client' })
        }
        if (scope === 'agent:lifecycle') {
          return json(reply, 200, { access_token: 'operator-lifecycle-token', token_type: 'Bearer', expires_in: 900 })
        }
        mandate += 1
        return json(reply, 200, { access_token: `operator-mandate-${mandate}`, token_type: 'Bearer', expires_in: 900 })
      }
      if (method === 'POST' && path.endsWith('/agents')) {
        session += 1
        const sessionId = `operator-session-${session}`
        sessionIds.push(sessionId)
        return json(reply, 200, { agent_session_id: sessionId })
      }
      if (method === 'POST' && path.endsWith('/delegations')) {
        return json(reply, 200, { delegation_edge_id: 'operator-delegation-1' })
      }
      if (method === 'DELETE' && path.includes('/agents/')) {
        reply.writeHead(204)
        return reply.end()
      }
      if (method === 'GET' && path === '/.well-known/jwks.json') return json(reply, 200, { keys: [] })
      return json(reply, 404, { error: `unexpected authority request: ${method} ${path}` })
    })
    fixtures.push(authority)

    const gateway = await startHttpFixture(async (request, reply) => {
      const body = await requestBody(request)
      gatewayCalls.push({
        authorization: request.headers.authorization ?? null,
        resource: typeof request.headers['x-caracal-resource'] === 'string' ? request.headers['x-caracal-resource'] : null,
        baggage: typeof request.headers.baggage === 'string' ? request.headers.baggage : null,
        path: request.url ?? '',
        body,
      })
      if (request.method !== 'POST' || request.url !== '/chat/completions') {
        return json(reply, 404, { error: `unexpected gateway request: ${request.method} ${request.url}` })
      }
      const forwarded = await fetch(`${upstream.url}/v1/chat/completions`, {
        method: request.method,
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json', authorization: `Bearer ${UPSTREAM_KEY}` },
        body,
      })
      reply.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' })
      reply.end(Buffer.from(await forwarded.arrayBuffer()))
    })
    fixtures.push(gateway)

    // buildApp constructs its provisioning AdminClient before listen(), but Fastify's actual
    // ephemeral port is known only after listen begins. A pre-bound proxy gives the client a
    // stable URL and resolves the live Fastify port when provisioning makes its first request,
    // eliminating the release-and-rebind race of reserving a port ahead of time.
    const controlApi = await startHttpFixture(async (request, reply) => {
      const address = app?.server.address()
      if (!address || typeof address === 'string') return json(reply, 503, { error: 'api_not_listening' })
      const body = await requestBody(request)
      const response = await fetch(`http://127.0.0.1:${address.port}${request.url ?? '/'}`, {
        method: request.method,
        headers: copyRequestHeaders(request),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      })
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value
      })
      reply.writeHead(response.status, responseHeaders)
      reply.end(Buffer.from(await response.arrayBuffer()))
    })
    fixtures.push(controlApi)

    const cfg = makeConfig(databaseUrl, {
      sts: authority.url,
      coordinator: authority.url,
      gateway: gateway.url,
      upstream: upstream.url,
      api: controlApi.url,
    })
    pool = newDB({
      connectionString: databaseUrl,
      max: cfg.db.poolMax,
      statementTimeoutMs: cfg.db.statementTimeoutMs,
      idleInTxTimeoutMs: cfg.db.idleInTxTimeoutMs,
      connectionTimeoutMs: cfg.db.connectionTimeoutMs,
      idleTimeoutMs: cfg.db.idleTimeoutMs,
      applicationName: cfg.workerId,
    })
    const db = scopedDB(pool)
    await seedBootstrapAdminToken(db, { envToken: ADMIN_TOKEN, log: () => {} })
    app = await buildApp({ cfg, db, redis: makeRedis() })
    const apiUrl = await app.listen({ host: cfg.host, port: cfg.port })
    await waitForGovernedExecution(apiUrl)

    return {
      app,
      apiUrl,
      adminToken: ADMIN_TOKEN,
      pool,
      providerId: PROVIDER_ID,
      model: MODEL,
      upstreamKey: UPSTREAM_KEY,
      resourceIdentifier: llmResourceIdentifier(PROVIDER_ID),
      sessionIds,
      stsScopes,
      stsExchanges,
      gatewayCalls,
      upstreamCalls,
      close,
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
