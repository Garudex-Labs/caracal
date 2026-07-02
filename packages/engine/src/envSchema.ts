// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single declarative table of every environment variable the Caracal stack consumes; renderers and the loader derive every other artifact from this file.

import type { StackMode } from './stackPaths.js'

export type { StackMode }
export type EnvKind = 'string' | 'enum' | 'url' | 'int' | 'bool' | 'secret'

export interface EnvSpec {
  kind: EnvKind
  description: string
  // Default value applied when the variable is not set in any override layer.
  // Per-mode overrides take precedence over the generic default.
  default?: string
  defaults?: Partial<Record<StackMode, string>>
  // Enum values, required when kind === 'enum'.
  values?: readonly string[]
  // When set, the variable cannot be overridden by operator files or process.env
  // in the listed modes; only build-time constants may set it. The loader aborts
  // `caracal up` with a clear error if the variable is overridden in those modes.
  pinned?: readonly StackMode[]
  // True when the variable resolves from a secret file via the *_FILE convention;
  // never written into env files or compose substitutions as a plaintext value.
  secret?: boolean
  // Basename of the secret file under the managed operator secret directory.
  file?: string
  // True when the variable should appear in the end-user operator template
  // ($CARACAL_HOME/caracal.env). Non-exposed vars stay internal to the schema.
  exposed?: boolean
  // True when the variable must be present in the listed modes; the loader
  // aborts with a missing-required-var error if it cannot be resolved.
  required?: readonly StackMode[]
}

// Order is preserved when rendering env files; group related vars together so the
// generated dev.env stays human-scannable.
export const ENV_SCHEMA = {
  // ─── Mode / version pins (immutable in rc and stable) ──────────────────────
  CARACAL_MODE: {
    kind: 'enum',
    values: ['dev', 'rc', 'stable'],
    description: 'Deployment surface. `dev` enables build-from-source and bootstrap routes.',
    defaults: { dev: 'dev', rc: 'rc', stable: 'stable' },
    pinned: ['rc', 'stable'],
  },
  CARACAL_VERSION: {
    kind: 'string',
    description: 'Published image tag for rc/stable. Dev installs derive from CARACAL_BASE_VERSION.',
    pinned: ['rc', 'stable'],
  },
  CARACAL_REGISTRY: {
    kind: 'string',
    description: 'OCI registry prefix for caracal-* images. Must end with `/`.',
    default: 'ghcr.io/garudex-labs/',
    pinned: ['rc', 'stable'],
  },
  CARACAL_BASE_VERSION: {
    kind: 'string',
    description: 'Dev base tag used to build local image names (<base>-dev.sha<sha>).',
    default: '2026.05.26',
  },
  CARACAL_DEV_SHA: {
    kind: 'string',
    description: 'Dev git sha embedded in locally built image tags.',
    default: 'local',
  },

  // ─── Postgres ──────────────────────────────────────────────────────────────
  POSTGRES_USER: { kind: 'string', description: 'Postgres role used by every service.', default: 'caracal' },
  POSTGRES_DB: { kind: 'string', description: 'Postgres database name used by every service.', default: 'caracal' },
  POSTGRES_PASSWORD: {
    kind: 'secret',
    description: 'Postgres password. Generated on first bootstrap; consumed via POSTGRES_PASSWORD_FILE.',
    secret: true,
    file: 'postgresPassword',
  },
  POSTGRES_SHARED_BUFFERS: { kind: 'string', description: 'shared_buffers tuning. Target ~25% of DB memory.', default: '256MB', exposed: true },
  POSTGRES_EFFECTIVE_CACHE_SIZE: { kind: 'string', description: 'effective_cache_size planner hint.', default: '768MB', exposed: true },
  POSTGRES_WORK_MEM: { kind: 'string', description: 'work_mem per sort/hash op.', default: '8MB', exposed: true },
  POSTGRES_MAINTENANCE_WORK_MEM: { kind: 'string', description: 'maintenance_work_mem for VACUUM/CREATE INDEX.', default: '64MB', exposed: true },
  POSTGRES_MAX_CONNECTIONS: { kind: 'int', description: 'max_connections ceiling.', default: '100', exposed: true },
  POSTGRES_LOG_MIN_DURATION_MS: { kind: 'int', description: 'Slow query log threshold in ms.', default: '500', exposed: true },

  // ─── Redis ─────────────────────────────────────────────────────────────────
  REDIS_PASSWORD: {
    kind: 'secret',
    description: 'Redis password. Generated on bootstrap; consumed via REDIS_PASSWORD_FILE.',
    secret: true,
    file: 'redisPassword',
  },
  REDIS_MAXMEMORY: {
    kind: 'string',
    description: 'Redis maxmemory ceiling. Must be ≤ CARACAL_REDIS_MEM_LIMIT.',
    default: '512mb',
    exposed: true,
  },

  // ─── Application secrets (file-backed only) ────────────────────────────────
  CARACAL_ADMIN_TOKEN: {
    kind: 'secret',
    description: 'Admin bearer token for /v1/* provisioning calls.',
    secret: true,
    file: 'caracalAdminToken',
  },
  CARACAL_COORDINATOR_TOKEN: {
    kind: 'secret',
    description: 'Coordinator operator token for protected metrics endpoints.',
    secret: true,
    file: 'caracalCoordinatorToken',
  },
  METRICS_BEARER: {
    kind: 'secret',
    description: 'Operator bearer token protecting /metrics and /metrics.json on STS, Gateway, Audit, API, and Coordinator.',
    secret: true,
    file: 'metricsBearer',
  },
  ZONE_KEK: {
    kind: 'secret',
    description: '32-byte zone key-encryption-key. Rotating destroys existing zones.',
    secret: true,
    file: 'zoneKek',
  },
  AUDIT_HMAC_KEY: {
    kind: 'secret',
    description: 'HMAC key for audit log chain integrity.',
    secret: true,
    file: 'auditHmacKey',
  },
  STREAMS_HMAC_KEY: {
    kind: 'secret',
    description: 'HMAC key for outbox/stream message integrity.',
    secret: true,
    file: 'streamsHmacKey',
  },
  GATEWAY_STS_HMAC_KEY: {
    kind: 'secret',
    description: 'HMAC key used by Gateway to authenticate brokered STS exchanges.',
    secret: true,
    file: 'gatewayStsHmacKey',
  },

  // ─── Networking / public surface ───────────────────────────────────────────
  CARACAL_STS_ISSUER_URL: {
    kind: 'url',
    description: 'Public issuer URL advertised by STS in JWT `iss` and JWKS discovery. Set to your reverse-proxy hostname when fronted.',
    defaults: { dev: 'http://sts:8080', rc: 'http://localhost:8080', stable: 'http://localhost:8080' },
    exposed: true,
  },
  UPSTREAM_HOST_ALLOWLIST: {
    kind: 'string',
    description: 'Gateway: optional comma-separated allowlist pinning upstream egress to named hosts. Empty permits any operator-provisioned host. Private and on-prem upstreams are allowed by default; dangerous ranges (cloud metadata, loopback, CGNAT, multicast) are always blocked.',
    default: '',
    exposed: true,
  },

  // ─── Audit Parquet export (optional) ───────────────────────────────────────
  AUDIT_EXPORT_S3_ENDPOINT: {
    kind: 'string',
    description: 'S3 endpoint for Parquet export. Blank disables export.',
    default: '',
    exposed: true,
  },
  AUDIT_EXPORT_S3_BUCKET: { kind: 'string', description: 'S3 bucket for Parquet export.', default: '', exposed: true },
  AUDIT_EXPORT_S3_REGION: { kind: 'string', description: 'S3 region for Parquet export.', default: 'us-east-1', exposed: true },

  // ─── Control plane (optional, in-process API plugin, gate-file toggled) ─────
  CONTROL_AUDIENCE: {
    kind: 'string',
    description: 'OAuth2 `aud` claim the in-process control plane requires on inbound tokens.',
    default: 'caracal-control',
    exposed: true,
  },
  CONTROL_RATE_CAPACITY: { kind: 'int', description: 'Token-bucket capacity per Control client.', default: '60', exposed: true },
  CONTROL_RATE_WINDOW_SEC: { kind: 'int', description: 'Token-bucket window in seconds.', default: '60', exposed: true },
  CONTROL_REPLAY_TTL_SEC: { kind: 'int', description: 'JTI replay-cache TTL in seconds.', default: '3600', exposed: true },

  // ─── Container resource limits ─────────────────────────────────────────────
  CARACAL_APP_CPU_LIMIT: { kind: 'string', description: 'Per-app-container CPU limit.', default: '1.0', exposed: true },
  CARACAL_APP_CPU_RESERVE: { kind: 'string', description: 'Per-app-container CPU reservation.', default: '0.1', exposed: true },
  CARACAL_APP_MEM_LIMIT: { kind: 'string', description: 'Per-app-container memory limit.', default: '512M', exposed: true },
  CARACAL_APP_MEM_RESERVE: { kind: 'string', description: 'Per-app-container memory reservation.', default: '128M', exposed: true },
  CARACAL_DB_CPU_LIMIT: { kind: 'string', description: 'Postgres CPU limit.', default: '2.0', exposed: true },
  CARACAL_DB_MEM_LIMIT: { kind: 'string', description: 'Postgres memory limit.', default: '1G', exposed: true },
  CARACAL_DB_MEM_RESERVE: { kind: 'string', description: 'Postgres memory reservation.', default: '256M', exposed: true },
  CARACAL_REDIS_CPU_LIMIT: { kind: 'string', description: 'Redis CPU limit.', default: '1.0', exposed: true },
  CARACAL_REDIS_MEM_LIMIT: { kind: 'string', description: 'Redis memory limit.', default: '768M', exposed: true },
  CARACAL_REDIS_MEM_RESERVE: { kind: 'string', description: 'Redis memory reservation.', default: '128M', exposed: true },

  // ─── Observability ─────────────────────────────────────────────────────────
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    kind: 'string',
    description: 'OTLP collector endpoint. Blank disables traces/metrics export.',
    default: '',
    exposed: true,
  },
  LOG_LEVEL: { kind: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], description: 'Log verbosity for all services.', default: 'info', exposed: true },
  OPERATOR_UPSTREAM_ALLOWLIST: {
    kind: 'string',
    description: 'Comma-separated host allowlist the Operator LLM normalizer may forward to. Blank allows any (dev).',
    default: '',
    exposed: true,
  },
} as const satisfies Record<string, EnvSpec>

export type EnvKey = keyof typeof ENV_SCHEMA

export function envEntries(): [EnvKey, EnvSpec][] {
  return Object.entries(ENV_SCHEMA) as [EnvKey, EnvSpec][]
}

export function resolveDefault(spec: EnvSpec, mode: StackMode): string | undefined {
  if (spec.defaults && spec.defaults[mode] !== undefined) return spec.defaults[mode]
  return spec.default
}

export function isPinned(spec: EnvSpec, mode: StackMode): boolean {
  return Boolean(spec.pinned?.includes(mode))
}
