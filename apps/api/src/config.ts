// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API service configuration loaded from environment variables.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { getenv, mustGetenv, intEnv, boolEnv, resolveFileSecrets, isPublished } from '@caracalai/core'
import type { ProviderConfig } from './operator-gateway.js'

function loadEnvChain(): void {
  const seen = new Set<string>()
  const candidates: string[] = []
  const mode = process.env.CARACAL_MODE
  const isDevMode = mode === 'dev' && process.env.NODE_ENV !== 'production'

  if (process.env.CARACAL_ENV_FILE) candidates.push(resolve(process.env.CARACAL_ENV_FILE))
  if (isDevMode && process.env.CARACAL_REPO_ROOT) {
    candidates.push(join(process.env.CARACAL_REPO_ROOT, 'infra', 'docker', 'local.env'))
    candidates.push(join(process.env.CARACAL_REPO_ROOT, 'infra', 'docker', 'dev.env'))
  }
  if (!isDevMode && process.env.CARACAL_HOME) {
    candidates.push(join(process.env.CARACAL_HOME, 'caracal.env'))
  }

  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    if (existsSync(path)) loadEnvFile(path)
  }
}

loadEnvChain()
resolveFileSecrets([
  'DATABASE_URL',
  'REDIS_URL',
  'CARACAL_ADMIN_TOKEN',
  'ZONE_KEK',
  'STREAMS_HMAC_KEY',
  'AUDIT_HMAC_KEY',
  'GATEWAY_STS_HMAC_KEY',
  'METRICS_BEARER',
  'CONTROL_API_TOKEN',
  'API_OPERATOR_CONTROL_CLIENT_SECRET',
])

export interface Config {
  port: number
  host: string
  databaseUrl: string
  redisUrl: string
  stsUrl: string
  // The data-plane endpoints the Operator's governed LLM transport routes through: the
  // gateway it presents minted mandates to and the coordinator it spawns its short-lived
  // agent sessions on. Defaulted for the standard deployment topology; never an end-user
  // surface.
  gatewayUrl: string
  coordinatorUrl: string
  operatorLlmProxyUrl: string
  gatewayStsHmacKey: Buffer | null
  auditHmacKey: Buffer | null
  logLevel: string
  bootstrapAdminToken: string | null
  shutdownGraceMs: number
  workerId: string
  bodyLimitBytes: number
  requestTimeoutMs: number
  keepAliveTimeoutMs: number
  db: {
    poolMax: number
    statementTimeoutMs: number
    idleInTxTimeoutMs: number
    connectionTimeoutMs: number
    idleTimeoutMs: number
  }
  outbox: {
    pollIntervalMs: number
    batchSize: number
    lockDurationSec: number
    maxAttempts: number
    streamMaxLen: number
  }
  readyRateLimitPerMin: number
  v1RateLimitPerMin: number
  adminAuthFailLimitPerMin: number
  lastUsedDebounceSec: number
  maxResourcesPerZone: number
  readyOutboxDeadMax: number
  trustProxy: boolean
  enableDocs: boolean
  operatorEnabled: boolean
  operatorAllowedCapabilities: string[] | null
  operatorSystemZones: string[]
  operatorAiProviders: ProviderConfig[]
  // Caracal-governed autopilot: operatorAutopilotEnabled is the deployment master switch (off by
  // default). When on, an agent-mode conversation that engages autopilot has its plan approvals
  // auto-satisfied; the switch is set here in Caracal and never by the model or a conversation.
  operatorAutopilotEnabled: boolean
  // Caracal-set governance over the Operator's model usage, enforced above the spine: a hard
  // ceiling on a single completion's output tokens and a per-turn model-call budget. Both have
  // safe defaults that bound runaways without affecting normal operation; zero lifts a bound.
  operatorAiMaxOutputTokens: number
  operatorAiMaxCallsPerTurn: number
  // Internal-only: when set, the Operator provisions and self-governs the reserved
  // caracal.sys system zone, executing through the governed control plane as a real
  // least-privilege control identity — exactly as a customer's control key does — rather
  // than borrowing the admin token. The system zone and that identity are provisioned
  // autonomously at startup; the only knob is the sealed client secret below, so the user
  // surface is one secret rather than a hand-wired identity.
  operatorSelfGovern: boolean
  // The sealed client secret for the Operator's reserved control identity. Sourced from
  // platform config (file-resolvable like every platform secret) and never set by an end
  // user. Null leaves governed execution unconfigured.
  operatorControlSecret: string | null
  metricsBearer: string | null
  control: ControlConfig | null
}

// Internal-only: the resolved credentials and zone binding for the Operator's caracal.sys
// control identity, assembled at startup from the provisioned system zone plus the sealed
// secret. Strictly a platform-internal adapter; never exposed to or set by end users.
export interface OperatorControlIdentity {
  applicationId: string
  clientSecret: string
  zoneId: string
}

export interface ControlConfig {
  jwksUrl: string
  issuer: string
  audience: string
  apiUrl: string
  apiToken: string
  rateCapacity: number
  rateWindowSec: number
  ipRateLimitPerMin: number
  replayTtlSec: number
  gateFile: string | undefined
}

function loadControlConfig(port: number): ControlConfig | null {
  if (getenv('CARACAL_CONTROL_ENABLED', 'false') !== 'true') return null
  return {
    jwksUrl: mustGetenv('STS_JWKS_URL'),
    issuer: mustGetenv('STS_ISSUER_URL'),
    audience: mustGetenv('CONTROL_AUDIENCE'),
    apiUrl: getenv('CARACAL_API_URL', `http://127.0.0.1:${port}`),
    apiToken: mustGetenv('CONTROL_API_TOKEN'),
    rateCapacity: intEnv('CONTROL_RATE_CAPACITY', 60, 1),
    rateWindowSec: intEnv('CONTROL_RATE_WINDOW_SEC', 60, 1),
    ipRateLimitPerMin: intEnv('CONTROL_INVOKE_IP_RATE_LIMIT_PER_MIN', 120, 0),
    replayTtlSec: intEnv('CONTROL_REPLAY_TTL_SEC', 3600, 1),
    gateFile: process.env.CONTROL_GATE_FILE || undefined,
  }
}

function deriveWorkerId(): string {
  return process.env.WORKER_ID ?? `${process.env.HOSTNAME ?? 'api'}:${process.pid}`
}

// Parses a comma-separated env list into trimmed, non-empty entries, returning null
// when unset so callers can fall back to a default rather than an empty grant.
function csvEnv(key: string): string[] | null {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return null
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000

// Resolves the ordered Operator AI provider list from the environment. The order of
// API_OPERATOR_AI_PROVIDERS is the failover order. Each provider id X is configured
// through API_OPERATOR_AI_X_BASE_URL / _MODEL / _API_KEY / _TIMEOUT_MS, where the key
// is optional so local backends that need no credential are supported. A provider id
// without a base URL or model is a configuration error and fails closed.
function loadOperatorAiProviders(): ProviderConfig[] {
  const ids = csvEnv('API_OPERATOR_AI_PROVIDERS')
  if (!ids) return []
  const providers: ProviderConfig[] = []
  for (const id of ids) {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error(`Invalid AI provider id '${id}': must match ${PROVIDER_ID_PATTERN}`)
    }
    const upper = id.toUpperCase()
    const baseUrl = process.env[`API_OPERATOR_AI_${upper}_BASE_URL`]
    const model = process.env[`API_OPERATOR_AI_${upper}_MODEL`]
    if (!baseUrl || !model) {
      throw new Error(`AI provider '${id}' requires API_OPERATOR_AI_${upper}_BASE_URL and _MODEL`)
    }
    providers.push({
      id,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey: process.env[`API_OPERATOR_AI_${upper}_API_KEY`] || undefined,
      timeoutMs: intEnv(`API_OPERATOR_AI_${upper}_TIMEOUT_MS`, DEFAULT_PROVIDER_TIMEOUT_MS, 1),
      contextWindow: intEnv(`API_OPERATOR_AI_${upper}_CONTEXT_WINDOW`, 0, 0),
    })
  }
  return providers
}

// Internal-only: resolves whether the Operator should self-govern the caracal.sys system
// zone. Governed execution requires the control plane (checked by the caller) and the
// sealed control secret; the system zone and identity are provisioned autonomously at
// startup, so the only user-facing knob is the secret.
function loadOperatorSelfGovern(): boolean {
  return boolEnv('API_OPERATOR_SELF_GOVERN', false)
}

export function loadConfig(): Config {
  const gatewayStsHmacKey = process.env.GATEWAY_STS_HMAC_KEY ? Buffer.from(process.env.GATEWAY_STS_HMAC_KEY, 'hex') : null
  if (gatewayStsHmacKey && gatewayStsHmacKey.length < 32) {
    throw new Error('GATEWAY_STS_HMAC_KEY must be hex-encoded with at least 32 bytes')
  }
  const auditHmacKey = process.env.AUDIT_HMAC_KEY ? Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex') : null
  if (auditHmacKey && auditHmacKey.length < 32) {
    throw new Error('AUDIT_HMAC_KEY must be hex-encoded with at least 32 bytes')
  }
  const port = intEnv('PORT', 3000, 1)
  const control = loadControlConfig(port)
  if (control && isPublished() && !auditHmacKey) {
    throw new Error('AUDIT_HMAC_KEY is required when CARACAL_CONTROL_ENABLED=true and CARACAL_MODE=rc or stable')
  }
  return {
    port,
    host: getenv('HOST', process.env.CARACAL_MODE === 'rc' || process.env.CARACAL_MODE === 'stable' ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: mustGetenv('DATABASE_URL'),
    redisUrl: mustGetenv('REDIS_URL'),
    stsUrl: getenv('STS_URL', 'http://localhost:8080'),
    gatewayUrl: getenv('CARACAL_GATEWAY_URL', 'http://localhost:8081'),
    coordinatorUrl: getenv('CARACAL_COORDINATOR_URL', 'http://localhost:4000'),
    operatorLlmProxyUrl: getenv('API_OPERATOR_LLM_PROXY_URL', 'http://litellm:4000/v1'),
    gatewayStsHmacKey,
    auditHmacKey,
    logLevel: getenv('LOG_LEVEL', 'info'),
    bootstrapAdminToken: process.env.CARACAL_ADMIN_TOKEN ?? null,
    shutdownGraceMs: intEnv('SHUTDOWN_GRACE_MS', 15_000, 1),
    workerId: deriveWorkerId(),
    bodyLimitBytes: intEnv('API_BODY_LIMIT_BYTES', 1_048_576, 1),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 30_000, 1),
    // Hold idle keep-alive sockets longer than the typical load-balancer idle window (≈60s) so
    // the LB never reuses a connection the server is simultaneously closing, which surfaces as
    // sporadic 502s during steady traffic.
    keepAliveTimeoutMs: intEnv('KEEP_ALIVE_TIMEOUT_MS', 75_000, 1),
    db: {
      poolMax: intEnv('DB_POOL_MAX', 20, 1),
      statementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 15_000, 1),
      idleInTxTimeoutMs: intEnv('DB_IDLE_IN_TX_TIMEOUT_MS', 30_000, 1),
      connectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5_000, 1),
      idleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS', 30_000, 1),
    },
    outbox: {
      pollIntervalMs: intEnv('OUTBOX_POLL_MS', 250, 1),
      batchSize: intEnv('OUTBOX_BATCH_SIZE', 32, 1),
      lockDurationSec: intEnv('OUTBOX_LOCK_SEC', 30, 1),
      maxAttempts: intEnv('OUTBOX_MAX_ATTEMPTS', 100, 1),
      streamMaxLen: intEnv('OUTBOX_STREAM_MAXLEN', 100_000, 1),
    },
    readyRateLimitPerMin: intEnv('READY_RATE_LIMIT_PER_MIN', 120, 0),
    v1RateLimitPerMin: intEnv('API_V1_RATE_LIMIT_PER_MIN', 600, 0),
    adminAuthFailLimitPerMin: intEnv('ADMIN_AUTH_FAIL_LIMIT_PER_MIN', 60, 0),
    lastUsedDebounceSec: intEnv('ADMIN_TOKEN_LAST_USED_DEBOUNCE_SEC', 60, 0),
    maxResourcesPerZone: intEnv('API_MAX_RESOURCES_PER_ZONE', 100_000, 0),
    readyOutboxDeadMax: intEnv('API_READY_OUTBOX_DEAD_MAX', 0, 0),
    trustProxy: boolEnv('TRUST_PROXY', false),
    enableDocs: boolEnv('API_ENABLE_DOCS', !isPublished()),
    operatorEnabled: boolEnv('API_OPERATOR_ENABLED', true),
    operatorAllowedCapabilities: csvEnv('API_OPERATOR_ALLOWED_CAPABILITIES'),
    operatorSystemZones: csvEnv('API_OPERATOR_SYSTEM_ZONES') ?? [],
    operatorAiProviders: loadOperatorAiProviders(),
    operatorAutopilotEnabled: boolEnv('API_OPERATOR_AUTOPILOT_ENABLED', false),
    operatorAiMaxOutputTokens: intEnv('API_OPERATOR_AI_MAX_OUTPUT_TOKENS', 4096, 0),
    operatorAiMaxCallsPerTurn: intEnv('API_OPERATOR_AI_MAX_CALLS_PER_TURN', 12, 0),
    operatorSelfGovern: loadOperatorSelfGovern(),
    operatorControlSecret: process.env.API_OPERATOR_CONTROL_CLIENT_SECRET?.trim() || null,
    metricsBearer: process.env.METRICS_BEARER ?? null,
    control,
  }
}
