// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fastify app factory: registers plugins, decorations, and all route handlers.

import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import pino from 'pino'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
import { redisMinuteBucket } from './redis.js'
import { adminAuthPlugin } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { controlPlugin } from './control/plugin.js'
import { AdminClient } from '@caracalai/admin'
import { provisionSystemZone, llmResourceIdentifier, type GovernedUpstream } from './system-zone.js'
import { createOperatorLlmTransport, type OperatorLlmTransport } from './operator-llm-transport.js'
import type { ProviderConfig } from './operator-gateway.js'
import { createOperatorAiManager, buildStoreProviderConfigs, type OperatorAiManager } from './operator-ai-manager.js'
import { listAiProviders } from './operator-ai-store.js'
import type { OperatorControlIdentity } from './config.js'
import {
  isPublished,
  getTraceContext,
  parseTraceparent,
  bindTrace,
  renderObservabilityMetrics,
  buildPinoRedactPaths,
  instrumentFastifyApp,
  withTimeout,
  CaracalError,
  pathOnly,
  createLogger,
} from '@caracalai/core'
import { zonesRoutes } from './routes/zones.js'
import { applicationsRoutes } from './routes/applications.js'
import { resourcesRoutes } from './routes/resources.js'
import { providersRoutes } from './routes/providers.js'
import { policiesRoutes } from './routes/policies.js'
import { policySetsRoutes } from './routes/policy-sets.js'
import { grantsRoutes } from './routes/grants.js'
import { stepUpChallengesRoutes } from './routes/step-up-challenges.js'
import { policyTemplatesRoutes } from './routes/policy-templates.js'
import { zoneEventsRoutes } from './routes/zone-events.js'
import { adminTokensRoutes } from './routes/admin-tokens.js'
import { operatorRoutes } from './routes/operator.js'
import { buildAutopilotPolicy } from './operator-autopilot.js'
import { buildGovernanceLimits } from './operator-ai-governance.js'

import './fastify-augmentation.js'

const READY_CHECK_TIMEOUT_MS = 5_000

// Stable Postgres advisory-lock key that serializes caracal.sys system-zone provisioning
// across API instances. A fixed constant so every instance contends for the same lock.
const SYSTEM_ZONE_PROVISION_LOCK = 4143012026

interface OutboxHealth {
  pendingCount: number
  deadCount: number
  oldestPendingAgeSeconds: number
  oldestDeadAgeSeconds: number
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

async function queryOutboxHealth(db: DB): Promise<OutboxHealth> {
  const { rows } = await db.query<{
    pending_count: string | number
    dead_count: string | number
    oldest_pending_age_seconds: string | number | null
    oldest_dead_age_seconds: string | number | null
  }>(
    `SELECT
       count(*) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at <> 'infinity'::timestamptz
       ) AS pending_count,
       count(*) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at = 'infinity'::timestamptz
       ) AS dead_count,
       COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at <> 'infinity'::timestamptz
       )), 0) AS oldest_pending_age_seconds,
       COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at = 'infinity'::timestamptz
       )), 0) AS oldest_dead_age_seconds
     FROM event_outbox`,
  )
  const row = rows[0]
  return {
    pendingCount: toNumber(row?.pending_count),
    deadCount: toNumber(row?.dead_count),
    oldestPendingAgeSeconds: toNumber(row?.oldest_pending_age_seconds),
    oldestDeadAgeSeconds: toNumber(row?.oldest_dead_age_seconds),
  }
}

function renderOutboxMetrics(health: OutboxHealth): string {
  return [
    '# HELP caracal_api_outbox_pending_total Undispatched API outbox rows that remain eligible for retry.',
    '# TYPE caracal_api_outbox_pending_total gauge',
    `caracal_api_outbox_pending_total ${health.pendingCount}`,
    '# HELP caracal_api_outbox_dead_total API outbox rows abandoned after exhausting delivery attempts.',
    '# TYPE caracal_api_outbox_dead_total gauge',
    `caracal_api_outbox_dead_total ${health.deadCount}`,
    '# HELP caracal_api_outbox_oldest_pending_age_seconds Age in seconds of the oldest pending API outbox row.',
    '# TYPE caracal_api_outbox_oldest_pending_age_seconds gauge',
    `caracal_api_outbox_oldest_pending_age_seconds ${health.oldestPendingAgeSeconds}`,
    '# HELP caracal_api_outbox_oldest_dead_age_seconds Age in seconds of the oldest dead API outbox row.',
    '# TYPE caracal_api_outbox_oldest_dead_age_seconds gauge',
    `caracal_api_outbox_oldest_dead_age_seconds ${health.oldestDeadAgeSeconds}`,
  ].join('\n')
}

export interface AppDeps {
  cfg: Config
  db: DB
  redis: RedisClient
  isDraining?: () => boolean
}

export async function buildApp({ cfg, db, redis, isDraining }: AppDeps) {
  const redactPaths = buildPinoRedactPaths()
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      base: {
        service: 'api',
        env: process.env.CARACAL_ENV || process.env.NODE_ENV || 'development',
        version: process.env.CARACAL_VERSION || 'dev',
        pid: process.pid,
        hostname: hostname(),
      },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        req: (request: { method?: string; url?: string; ip?: string }) => ({
          method: request.method,
          url: request.url ? pathOnly(request.url) : request.url,
          ip: request.ip,
        }),
      },
      redact: { paths: redactPaths, censor: '***' },
      mixin: () => {
        const tc = getTraceContext()
        const out: Record<string, unknown> = {}
        if (tc?.traceId) out.trace_id = tc.traceId
        if (tc?.spanId) out.span_id = tc.spanId
        return out
      },
    },
    bodyLimit: cfg.bodyLimitBytes,
    requestTimeout: cfg.requestTimeoutMs,
    keepAliveTimeout: cfg.keepAliveTimeoutMs,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      const value = Array.isArray(incoming) ? incoming[0] : incoming
      return value && /^[A-Za-z0-9_.\-:]{1,128}$/.test(value) ? value : randomUUID()
    },
    requestIdHeader: 'x-request-id',
    disableRequestLogging: false,
    trustProxy: cfg.trustProxy,
  })

  app.decorate('db', db)
  app.decorate('redis', redis)
  app.decorate('cfg', cfg)
  instrumentFastifyApp(app, 'caracal-api')

  app.addHook('onRequest', async (req) => {
    const h = req.headers['traceparent']
    const value = Array.isArray(h) ? h[0] : h
    const tc = parseTraceparent(value)
    bindTrace({ traceId: tc.traceId, spanId: tc.spanId || req.id })
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
      reply.code(400).send(
        new CaracalError('invalid_body', 'Request body failed validation', {
          requestId: req.id,
          details: { issues },
        }).toJSON(),
      )
      return
    }
    req.log.error({ err }, 'unhandled route error')
    const status = (err as { statusCode?: number }).statusCode
    const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
    reply.code(code).send(
      new CaracalError('internal_error', 'The service failed to process the request', {
        requestId: req.id,
      }).toJSON(),
    )
  })

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id)
    if (req.url.startsWith('/v1/')) {
      reply.header('x-content-type-options', 'nosniff')
      reply.header('referrer-policy', 'no-referrer')
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  if (cfg.v1RateLimitPerMin > 0) {
    // Pre-auth bucket keyed by IP. After-auth re-evaluation happens in preHandler
    // so authenticated callers are accounted by actor.id (preventing X-Forwarded-For evasion).
    // Deployment requirement when trustProxy=true: the upstream proxy must strip any
    // client-supplied X-Forwarded-For; otherwise unauthenticated callers can rotate the
    // header to bypass the per-IP bucket.
    const tick = async (key: string): Promise<number> => {
      const n = await redis.incr(key)
      if (n === 1) await redis.expire(key, 90)
      return n
    }
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/v1/')) return
      const minute = await redisMinuteBucket(redis)
      const count = await tick(`api:v1_rl:ip:${req.ip}:${minute}`)
      if (count > cfg.v1RateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    })
    app.addHook('preHandler', async (req, reply) => {
      if (!req.url.startsWith('/v1/')) return
      if (!req.actor?.id) return
      const minute = await redisMinuteBucket(redis)
      const count = await tick(`api:v1_rl:actor:${req.actor.id}:${minute}`)
      if (count > cfg.v1RateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    })
  }

  await app.register(adminAuthPlugin, {
    db,
    redis,
    authFailLimitPerMin: cfg.adminAuthFailLimitPerMin,
    lastUsedDebounceSec: cfg.lastUsedDebounceSec,
    accountAssertionKey: cfg.bootstrapAdminToken,
  })
  registerAdminAuditHook(app, { db, hmacKey: cfg.auditHmacKey })

  if (cfg.enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Caracal API', version: process.env.CARACAL_VERSION ?? '0.0.0-dev' },
        servers: [{ url: `http://localhost:${cfg.port}` }],
      },
    })
    if (!isPublished()) {
      await app.register(swaggerUI, { routePrefix: '/docs' })
    }
  }

  await app.register(zonesRoutes, { prefix: '/v1' })
  await app.register(applicationsRoutes, { prefix: '/v1' })
  await app.register(resourcesRoutes, { prefix: '/v1' })
  await app.register(providersRoutes, { prefix: '/v1' })
  await app.register(policiesRoutes, { prefix: '/v1' })
  await app.register(policySetsRoutes, { prefix: '/v1' })
  await app.register(grantsRoutes, { prefix: '/v1' })
  await app.register(stepUpChallengesRoutes, { prefix: '/v1' })
  await app.register(policyTemplatesRoutes, { prefix: '/v1' })
  await app.register(zoneEventsRoutes, { prefix: '/v1' })
  await app.register(adminTokensRoutes, { prefix: '/v1' })
  // Mutable holder for the Operator's resolved control identity. Populated by the system
  // zone provisioner after the server is listening, when the control plane is reachable over
  // loopback; until then the getter returns null and governed execution stays unconfigured.
  const operatorControlIdentity: { current: OperatorControlIdentity | null } = { current: null }

  // When self-governance is active, the Operator must not hold its upstream LLM keys: the
  // provisioner seals each keyed provider into Caracal, and here the matching providers are
  // re-pointed at the gateway with a per-provider transport that mints and presents a Caracal
  // resource mandate. The key is dropped from the in-process config, so a governed provider
  // calls its model only through Caracal's own authority plane. Keyless local providers need
  // no protection and are left calling directly. The transport resolves the Operator identity
  // lazily because it is provisioned after the server is listening; until then a governed call
  // fails closed rather than leaking a key.
  const governanceActive = Boolean(cfg.control && cfg.operatorSelfGovern && cfg.operatorControlSecret)

  // The Operator's governed LLM transport mints and presents a Caracal resource mandate per
  // call, so a governed provider reaches its model only through Caracal's own authority plane.
  // It resolves the Operator identity lazily because that identity is provisioned after the
  // server is listening; until then a governed call fails closed rather than leaking a key.
  const transport: OperatorLlmTransport | null = governanceActive
    ? createOperatorLlmTransport({
        stsUrl: cfg.stsUrl,
        coordinatorUrl: cfg.coordinatorUrl,
        gatewayUrl: cfg.gatewayUrl,
        resolveIdentity: () => operatorControlIdentity.current,
      })
    : null

  // The env-configured providers, governed when a key is supplied (the key is dropped from the
  // in-process config and the call is routed through the gateway) and direct when keyless.
  const envConfigs: ProviderConfig[] =
    governanceActive && transport
      ? cfg.operatorAiProviders.map((provider) =>
          provider.apiKey
            ? {
                ...provider,
                apiKey: undefined,
                baseUrl: cfg.gatewayUrl,
                transport: transport.governedFetch(llmResourceIdentifier(provider.id)),
              }
            : provider,
        )
      : cfg.operatorAiProviders

  // The store-managed providers' gateway entries, rebuilt whenever the registry changes so a
  // provider added or edited from the console applies to the next request without an env edit.
  let storeConfigs: ProviderConfig[] = []
  const loadAiProviders = (): ProviderConfig[] => [...envConfigs, ...storeConfigs]

  // The env upstreams that must always remain in the desired set the reconciler prunes against,
  // so a store reconcile never archives an env-sealed provider.
  const envGovernedUpstreams: GovernedUpstream[] = cfg.operatorAiProviders
    .filter((provider) => provider.apiKey)
    .map((provider) => ({ id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey! }))

  // The admin client the provisioner and the runtime manager run as: the global-scope
  // bootstrap identity, the only actor allowed to seal credentials in the reserved system zone.
  const provisionAdmin = cfg.control ? new AdminClient({ apiUrl: cfg.control.apiUrl, adminToken: cfg.control.apiToken }) : null

  // The runtime manager for governed model providers. Present only when self-governance can seal
  // keys; the routes surface its absence so the console explains the prerequisite rather than
  // accepting a key it cannot protect.
  const aiManager: OperatorAiManager | null =
    governanceActive && transport && provisionAdmin
      ? createOperatorAiManager({
          db,
          admin: provisionAdmin,
          resolveIdentity: () => operatorControlIdentity.current,
          envUpstreams: envGovernedUpstreams,
          gatewayUrl: cfg.gatewayUrl,
          proxyUrl: cfg.operatorLlmProxyUrl,
          transport,
          onRegistryChange: (configs) => {
            storeConfigs = configs
          },
        })
      : null

  await app.register(operatorRoutes, {
    prefix: '/v1',
    enabled: cfg.operatorEnabled,
    allowedCapabilities: cfg.operatorAllowedCapabilities,
    systemZones: cfg.operatorSystemZones,
    loadAiProviders,
    aiManager,
    autopilotPolicy: buildAutopilotPolicy({
      enabled: cfg.operatorAutopilotEnabled,
    }),
    aiGovernance: buildGovernanceLimits({
      maxOutputTokens: cfg.operatorAiMaxOutputTokens,
      maxCallsPerTurn: cfg.operatorAiMaxCallsPerTurn,
    }),
    resolveControlIdentity: () => operatorControlIdentity.current,
    controlEndpoints: cfg.control
      ? { stsUrl: cfg.stsUrl, audience: cfg.control.audience, controlUrl: cfg.control.apiUrl, controlEnabled: true }
      : null,
  })

  // When self-governance is enabled, provision the reserved caracal.sys system zone and the
  // Operator's least-privilege control identity once the server is listening — the only
  // point the in-process admin client can reach the control plane over loopback. The
  // Operator then governs that one zone. Provisioning failure leaves governed execution
  // unconfigured rather than crashing the API; a later restart retries.
  if (cfg.control && cfg.operatorSelfGovern && cfg.operatorControlSecret && provisionAdmin) {
    const secret = cfg.operatorControlSecret
    const audience = cfg.control.audience
    const isolatedSystemZone = new Set(cfg.operatorSystemZones)
    const admin = provisionAdmin
    const provisionLog = createLogger('api-system-zone', cfg.logLevel as 'info')
    // Deterministic by-slug lookup for the singleton system zone. Selecting regardless of
    // archival avoids a unique-slug conflict on create when an archived system zone exists,
    // and finds the zone no matter how many zones the deployment has (a list scan would miss
    // the oldest zone past the first page).
    const findZoneBySlug = async (slug: string): Promise<{ id: string } | null> => {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM zones WHERE slug = $1 LIMIT 1', [slug])
      return rows[0] ?? null
    }
    app.addHook('onListen', async () => {
      // Serialize provisioning across instances with a Postgres advisory lock, so two API
      // replicas starting together cannot both run the find-then-create lookups and create
      // duplicate reserved objects. The lock is held on a dedicated connection only for the
      // brief provisioning window and released in finally; a crash drops it with the
      // session. The provisioner is idempotent, so the instance that waits then converges on
      // the objects the first one created.
      const lock = await db.connect()
      try {
        await lock.query('SELECT pg_advisory_lock($1)', [SYSTEM_ZONE_PROVISION_LOCK])
        // The desired set is the env upstreams (re-sealed from their keys) plus the
        // store-managed providers (already sealed in a prior run, reconciled by identifier
        // without a key), so a restart never archives a console-added provider.
        const storeRecords = await listAiProviders(db)
        const storeUpstreams: GovernedUpstream[] = storeRecords.map((record) => ({
          id: record.slug,
          baseUrl: cfg.operatorLlmProxyUrl,
          auth: record.auth,
        }))
        const desiredUpstreams = [...envGovernedUpstreams, ...storeUpstreams]
        const identity = await provisionSystemZone(admin, secret, audience, findZoneBySlug, desiredUpstreams)
        operatorControlIdentity.current = {
          applicationId: identity.operatorApplicationId,
          clientSecret: secret,
          zoneId: identity.zoneId,
        }
        // Publish the store providers' gateway entries from the freshly reconciled resource
        // map, so a console-added provider is live immediately after a restart.
        const resourceBySlug = new Map(identity.governedResources.map((entry) => [entry.id, entry.resourceIdentifier]))
        if (transport) storeConfigs = buildStoreProviderConfigs(storeRecords, resourceBySlug, cfg.gatewayUrl, transport)
        if (isolatedSystemZone.has(identity.zoneId)) {
          // The Operator must govern its own system zone; listing it as an isolated zone
          // would block self-governance before the identity check. Warn rather than fail so
          // the rest of the platform still starts.
          provisionLog.warn('system zone is also listed as an isolated zone; self-governance will be blocked', {
            zone_id: identity.zoneId,
          })
        }
        provisionLog.info('system zone provisioned', {
          zone_id: identity.zoneId,
          operator_application_id: identity.operatorApplicationId,
          governed_resources: identity.governedResources.map((entry) => entry.resourceIdentifier),
        })
      } catch (err) {
        provisionLog.error('system zone provisioning failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [SYSTEM_ZONE_PROVISION_LOCK]).catch(() => {})
        lock.release()
      }
    })
  }

  if (cfg.control) {
    await app.register(controlPlugin, {
      cfg: cfg.control,
      redis,
      auditHmacKey: cfg.auditHmacKey,
      controlLogLevel: cfg.logLevel,
      resolvePlatformOperatorSubject: () => operatorControlIdentity.current?.applicationId ?? null,
    })
  }

  app.get('/health', async () => ({ ok: true }))
  app.get('/metrics', async (req, reply) => {
    if (cfg.metricsBearer) {
      const auth = req.headers.authorization
      const expected = `Bearer ${cfg.metricsBearer}`
      if (typeof auth !== 'string' || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    } else if (isPublished()) {
      // Published builds bind to 0.0.0.0; refuse to expose operational metrics
      // on the network unless an operator has provisioned METRICS_BEARER.
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const health = await withTimeout(queryOutboxHealth(db), READY_CHECK_TIMEOUT_MS, 'metrics outbox check timed out')
    reply.type('text/plain; version=0.0.4')
    return `${renderObservabilityMetrics()}\n${renderOutboxMetrics(health)}\n`
  })
  app.get('/ready', async (req, reply) => {
    if (cfg.readyRateLimitPerMin > 0) {
      const minute = await redisMinuteBucket(redis)
      const key = `api:ready_rl:${req.ip}:${minute}`
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, 90)
      if (count > cfg.readyRateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    }
    if (isDraining?.()) {
      reply.code(503)
      return { ok: false, draining: true }
    }
    try {
      await withTimeout(db.query('SELECT 1'), READY_CHECK_TIMEOUT_MS, 'ready postgres check timed out')
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_postgres_unreachable')
      return { ok: false, error: 'postgres_unreachable', dependency: 'postgres' }
    }
    try {
      const pong = await withTimeout(redis.ping(), READY_CHECK_TIMEOUT_MS, 'ready redis check timed out')
      if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`)
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_redis_unreachable')
      return { ok: false, error: 'redis_unreachable', dependency: 'redis' }
    }
    let outboxHealth: OutboxHealth
    try {
      outboxHealth = await withTimeout(queryOutboxHealth(db), READY_CHECK_TIMEOUT_MS, 'ready outbox check timed out')
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_outbox_unreachable')
      return { ok: false, error: 'outbox_unreachable', dependency: 'postgres' }
    }
    if (outboxHealth.deadCount > cfg.readyOutboxDeadMax) {
      reply.code(503)
      req.log.warn({ deadCount: outboxHealth.deadCount, limit: cfg.readyOutboxDeadMax }, 'ready_outbox_dead_messages')
      return { ok: false, error: 'outbox_dead_messages', deadCount: outboxHealth.deadCount, limit: cfg.readyOutboxDeadMax }
    }
    return { ok: true }
  })

  return app
}
