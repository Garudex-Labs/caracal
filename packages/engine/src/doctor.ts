// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared doctor diagnostics for operator health checks.

import type { Zone } from '@caracalai/admin'
import { discoverCoordinatorToken, discoverMetricsBearer } from '@caracalai/server-core'
import { DEFAULT_API_URL, DEFAULT_COORDINATOR_URL, DEFAULT_GATEWAY_URL, DEFAULT_ZONE_URL, resolveServiceUrl } from './runtimeConfig.js'
import { scrubTokens } from './crash.js'
import { adminTokenProvisionCommand, buildAdminClient as buildAdminClientCore, type AdminContext } from './shared.js'
import { runPreflightChecks, type PreflightCheck } from './preflight.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'
export type DoctorMode = 'system' | 'preflight'
export type DoctorSection = 'health' | 'readiness' | 'zones' | 'preflight'
export type ZoneScope = 'all' | 'selected' | 'none'
type ProbeHeaders = Record<string, string>

export interface DoctorCheck {
  section: DoctorSection
  check: string
  status: DoctorStatus
  detail: string
  advice?: string
}

export interface DoctorSummary {
  ok: number
  warn: number
  fail: number
  total: number
}

export interface DoctorContext {
  apiUrl: string
  zoneScope: ZoneScope
  zoneIds: string[]
}

export interface DoctorReport {
  command: 'doctor'
  mode: DoctorMode
  ready: boolean
  strict: boolean
  context: DoctorContext
  summary: DoctorSummary
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  zoneId?: string
  strict?: boolean
  preflightOnly?: boolean
  // Overrides the admin token the health and zone checks authenticate with. The Console BFF
  // passes its least-privilege read-only token so diagnostics - which only read - never run
  // under the deployment admin token. Unset everywhere else, so the discovered admin token is
  // used as before.
  adminToken?: string
  // Headers sent on every admin API request the zone checks make. The Console BFF carries the
  // signed per-account assertion here so the zone inventory and per-zone checks are scoped to
  // the requesting operator's own zones rather than the whole deployment.
  headers?: Record<string, string>
  // Whether the process running the checks is a data-plane host that owns the runtime
  // environment. `caracal doctor` runs on such a host and leaves this true, so it validates
  // local secret, database, and cache provisioning and reports a missing service URL as a
  // configuration failure. The Console BFF sets it false: it is a control-plane surface that
  // never holds sealing keys or storage credentials, so evaluating them there only fabricates
  // failures. With it false, the local runtime-environment preflight is skipped and a service
  // is probed for readiness only when its URL is explicitly configured, so the report reflects
  // real reachability instead of the checker's own missing configuration.
  localEnvironment?: boolean
}

interface MetricEvaluation {
  detail: string
  status: DoctorStatus
  advice?: string
}

interface ServiceTarget {
  name: string
  baseUrl: string
  metricsPath?: string
  evaluateMetrics?: (value: unknown) => MetricEvaluation
}

const AUDIT_LAG_WARN = 1000
const OUTBOX_PENDING_WARN = 500
const CLOCK_SKEW_WARN_MS = 2000
const CLOCK_SKEW_FAIL_MS = 30000

export const DOCTOR_SECTION_LABELS: Record<DoctorSection, string> = {
  health: 'System health',
  readiness: 'Service readiness',
  zones: 'Zone diagnostics',
  preflight: 'Local preflight',
}
export const DOCTOR_SECTION_ORDER: DoctorSection[] = ['health', 'readiness', 'zones', 'preflight']

const FETCH_TIMEOUT_MS = 5000
// Readiness and health probes hit live services whose dependency connections can briefly
// go cold (idle-evicted pools, failovers, GC pauses, network blips), making a single
// attempt occasionally exceed the timeout. Industry-standard probing tolerates that with a
// small number of retries before declaring a failure, so a transient spike never reports a
// healthy service as down. Only transport-level failures (timeout/abort/network) are
// retried; a definitive HTTP response is always taken at face value.
const PROBE_MAX_ATTEMPTS = 3
const PROBE_RETRY_BACKOFF_MS = 250

function message(err: unknown): string {
  return scrubTokens(err instanceof Error ? err.message : String(err))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Performs the probe request, retrying only when fetch itself fails (an aborted timeout or
// a network error). A resolved Response - success or error status - is returned to the
// caller unchanged so HTTP-level outcomes are never masked by retries.
async function probeFetch(url: string, headers?: ProbeHeaders): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error',
        headers,
      })
    } catch (err) {
      lastError = err
      if (attempt < PROBE_MAX_ATTEMPTS) await delay(PROBE_RETRY_BACKOFF_MS * attempt)
    }
  }
  throw lastError
}

function sanitize(value: string): string {
  return scrubTokens(value.replace(/\s+/g, ' ').trim()).slice(0, 240)
}

function normalizeHttpUrl(value: string, source: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (err) {
    throw new Error(`${source} must be an absolute HTTP(S) URL: ${(err as Error).message}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${source} must use http or https`)
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function serviceUrl(envKeys: string[], devDefault: string): string {
  for (const key of envKeys) {
    const value = process.env[key]
    if (value) return normalizeHttpUrl(value, key)
  }
  return normalizeHttpUrl(resolveServiceUrl(envKeys[0]!, devDefault), envKeys[0]!)
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value
  for (const part of path) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'number' ? current : undefined
}

function evaluateSTS(value: unknown): MetricEvaluation {
  const compileErrors = nestedNumber(value, ['opa', 'compile_errors'])
  const evalErrors = nestedNumber(value, ['opa', 'eval_errors'])
  const maxPolicyAge = nestedNumber(value, ['opa', 'max_policy_age_seconds'])
  const detail = `opa compile_errors=${compileErrors ?? '-'} eval_errors=${evalErrors ?? '-'} max_policy_age_seconds=${maxPolicyAge ?? '-'}`
  if ((compileErrors ?? 0) > 0) {
    return {
      detail,
      status: 'fail',
      advice:
        'STS cannot compile a policy bundle; token exchanges may deny or run on a stale bundle. Inspect the active policy set version and STS logs.',
    }
  }
  if ((evalErrors ?? 0) > 0) {
    return { detail, status: 'warn', advice: 'STS reported policy evaluation errors; review recent policy changes and STS logs.' }
  }
  return { detail, status: 'ok' }
}

function evaluateGateway(value: unknown): MetricEvaluation {
  const bindings = nestedNumber(value, ['bindings_loaded'])
  const revocations = nestedNumber(value, ['revocations_active'])
  const denied = nestedNumber(value, ['requests_denied'])
  return { detail: `bindings=${bindings ?? '-'} revocations=${revocations ?? '-'} denied=${denied ?? '-'}`, status: 'ok' }
}

function evaluateAudit(value: unknown): MetricEvaluation {
  const lag = nestedNumber(value, ['consumer_lag'])
  const dlq = nestedNumber(value, ['dlq_size'])
  const tamperMismatch = nestedNumber(value, ['tamper_mismatch_total'])
  const chainBreaks = nestedNumber(value, ['tamper_chain_breaks'])
  const hmacFailures = nestedNumber(value, ['hmac_failures_total'])
  const detail = `consumer_lag=${lag ?? '-'} dlq_size=${dlq ?? '-'} tamper_mismatch_total=${tamperMismatch ?? '-'} chain_breaks=${chainBreaks ?? '-'} hmac_failures=${hmacFailures ?? '-'}`
  if ((tamperMismatch ?? 0) > 0 || (chainBreaks ?? 0) > 0) {
    return {
      detail,
      status: 'fail',
      advice:
        'Audit chain integrity failure detected (tamper mismatch or chain break). Treat as a security incident: preserve evidence and investigate audit writers and key consistency.',
    }
  }
  if ((hmacFailures ?? 0) > 0) {
    return {
      detail,
      status: 'warn',
      advice: 'Audit HMAC verification failures detected; verify AUDIT_HMAC_KEY is identical across every audit writer.',
    }
  }
  if ((dlq ?? 0) > 0) {
    return {
      detail,
      status: 'warn',
      advice: 'Audit events are landing in the dead-letter queue; inspect parse or processing failures before they age out.',
    }
  }
  if ((lag ?? 0) > AUDIT_LAG_WARN) {
    return {
      detail,
      status: 'warn',
      advice: 'Audit consumer is lagging; recorded events may be delayed. Check audit consumer throughput and stream backlog.',
    }
  }
  return { detail, status: 'ok' }
}

function evaluateCoordinator(value: unknown): MetricEvaluation {
  const outboxDead = nestedNumber(value, ['outbox', 'dead'])
  const outboxPending = nestedNumber(value, ['outbox', 'pending'])
  const invocationsRunning = nestedNumber(value, ['invocations', 'running'])
  const detail = `outbox_pending=${outboxPending ?? '-'} outbox_dead=${outboxDead ?? '-'} invocations_running=${invocationsRunning ?? '-'}`
  if ((outboxDead ?? 0) > 0) {
    return {
      detail,
      status: 'warn',
      advice:
        'Coordinator outbox has dead rows; session lifecycle or revocation events failed delivery. Inspect and requeue the dead outbox rows.',
    }
  }
  if ((outboxPending ?? 0) > OUTBOX_PENDING_WARN) {
    return {
      detail,
      status: 'warn',
      advice: 'Coordinator outbox backlog is high; downstream propagation may be delayed. Confirm the outbox processor is running.',
    }
  }
  return { detail, status: 'ok' }
}

function addCheck(checks: DoctorCheck[], check: DoctorCheck): DoctorCheck {
  checks.push({ ...check, detail: sanitize(check.detail), advice: check.advice ? sanitize(check.advice) : undefined })
  return checks[checks.length - 1]!
}

async function runCheck(
  checks: DoctorCheck[],
  section: DoctorSection,
  check: string,
  fn: () => Promise<string>,
  advice?: string,
): Promise<DoctorCheck> {
  try {
    return addCheck(checks, { section, check, status: 'ok', detail: await fn() })
  } catch (err) {
    return addCheck(checks, { section, check, status: 'fail', detail: message(err), advice })
  }
}

function soloCheck(section: DoctorSection, check: string, fn: () => Promise<string>, advice?: string): Promise<DoctorCheck> {
  return runCheck([], section, check, fn, advice)
}

async function fetchOk(url: string, headers?: ProbeHeaders): Promise<string> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await probeFetch(target, headers)
  if (!res.ok) throw new Error(`HTTP ${res.status}${await failureReason(res)}`)
  return target
}

async function fetchJSON(url: string, headers?: ProbeHeaders): Promise<unknown> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await probeFetch(target, headers)
  if (!res.ok) throw new Error(`HTTP ${res.status}${await failureReason(res)}`)
  return await res.json()
}

async function failureReason(res: Response): Promise<string> {
  const value = sanitize(await res.text())
  if (!value) return ''
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const record = parsed as Record<string, unknown>
    for (const key of ['reason', 'error', 'error_description']) {
      const field = record[key]
      if (typeof field === 'string' && field !== '') return ` ${sanitize(field)}`
    }
    return ''
  } catch {
    return ` ${value.split(/\r?\n/, 1)[0]?.slice(0, 120)}`
  }
}

function serviceTarget(
  checks: DoctorCheck[],
  name: string,
  envKeys: string[],
  devDefault: string,
  metricsPath: string,
  evaluateMetrics: (value: unknown) => MetricEvaluation,
  skipIfUnset = false,
): ServiceTarget | undefined {
  // A control-plane vantage only knows the services whose URL it was explicitly given. Rather
  // than fabricate a configuration failure for a service it was never meant to reach, omit it.
  if (skipIfUnset && !envKeys.some((key) => process.env[key])) return undefined
  try {
    return { name, baseUrl: serviceUrl(envKeys, devDefault), metricsPath, evaluateMetrics }
  } catch (err) {
    addCheck(checks, {
      section: 'readiness',
      check: `${name} config`,
      status: 'fail',
      detail: message(err),
      advice: `Set ${envKeys[0]} to the ${name} service URL for this environment.`,
    })
    return undefined
  }
}

function coordinatorTokenHeaders(): ProbeHeaders | undefined {
  const token = discoverCoordinatorToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

function metricsBearerHeaders(): ProbeHeaders | undefined {
  const token = discoverMetricsBearer()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

async function runMetricsCheck(checks: DoctorCheck[], target: ServiceTarget, headers?: ProbeHeaders): Promise<void> {
  const body = await fetchJSON(`${target.baseUrl}${target.metricsPath}`, headers)
  const evaluation = target.evaluateMetrics ? target.evaluateMetrics(body) : { detail: 'queryable', status: 'ok' as DoctorStatus }
  addCheck(checks, {
    section: 'readiness',
    check: `${target.name} metrics`,
    status: evaluation.status,
    detail: evaluation.detail,
    advice: evaluation.advice,
  })
}

async function runProtectedMetrics(
  checks: DoctorCheck[],
  target: ServiceTarget,
  headers: ProbeHeaders | undefined,
  failAdvice: string,
): Promise<void> {
  try {
    await runMetricsCheck(checks, target, headers)
  } catch (err) {
    const detail = message(err)
    if (!headers && /^HTTP 401\b/.test(detail)) {
      addCheck(checks, {
        section: 'readiness',
        check: `${target.name} metrics`,
        status: 'warn',
        detail: 'protected; managed operator token not found',
        advice: 'Run `caracal up` to generate and mount the operator metrics token.',
      })
      return
    }
    addCheck(checks, {
      section: 'readiness',
      check: `${target.name} metrics`,
      status: 'fail',
      detail,
      advice: failAdvice,
    })
  }
}

async function runServiceChecks(
  checks: DoctorCheck[],
  apiUrl: string,
  opts: { skipUnsetServices: boolean; probeMetrics: boolean } = { skipUnsetServices: false, probeMetrics: true },
): Promise<void> {
  const skip = opts.skipUnsetServices
  const targets = [
    { name: 'api', baseUrl: apiUrl },
    serviceTarget(checks, 'sts', ['CARACAL_STS_URL', 'CARACAL_ZONE_URL'], DEFAULT_ZONE_URL, '/metrics.json', evaluateSTS, skip),
    serviceTarget(checks, 'gateway', ['CARACAL_GATEWAY_URL'], DEFAULT_GATEWAY_URL, '/metrics.json', evaluateGateway, skip),
    serviceTarget(checks, 'audit', ['CARACAL_AUDIT_URL'], 'http://localhost:9090', '/metrics.json', evaluateAudit, skip),
    serviceTarget(checks, 'coordinator', ['CARACAL_COORDINATOR_URL'], DEFAULT_COORDINATOR_URL, '/stats', evaluateCoordinator, skip),
  ].filter((target): target is ServiceTarget => target !== undefined)
  // Services are independent; probe them concurrently so one slow or timing-out service
  // never delays the rest of the report, then append results in target order so the
  // report stays deterministic.
  const probed = await Promise.all(
    targets.map(async (target) => {
      const local: DoctorCheck[] = []
      await runCheck(
        local,
        'readiness',
        `${target.name} readiness`,
        async () => fetchOk(`${target.baseUrl}/ready`),
        `Inspect ${target.name} logs and confirm the service is bound to ${target.baseUrl}.`,
      )
      // Protected metrics need an operator bearer the control-plane vantage is not issued, so it
      // reports service reachability from readiness alone rather than a spurious protected warning.
      if (target.metricsPath && opts.probeMetrics) {
        const headers = target.name === 'coordinator' ? coordinatorTokenHeaders() : metricsBearerHeaders()
        await runProtectedMetrics(local, target, headers, `Confirm ${target.name} exposes operator metrics on ${target.metricsPath}.`)
      }
      return local
    }),
  )
  for (const local of probed) checks.push(...local)
}

function preflightAdvice(check: PreflightCheck): string | undefined {
  if (check.status === 'ok') return undefined
  return 'Review local environment, secret files, and dependency endpoints before deployment.'
}

async function runPreflightSection(checks: DoctorCheck[]): Promise<void> {
  const preflight = await runPreflightChecks()
  for (const check of preflight) {
    addCheck(checks, {
      section: 'preflight',
      check: check.check,
      status: check.status,
      detail: check.detail,
      advice: preflightAdvice(check),
    })
  }
}

function count(checks: DoctorCheck[], status: DoctorStatus): number {
  return checks.filter((c) => c.status === status).length
}

function summary(checks: DoctorCheck[]): DoctorSummary {
  return {
    ok: count(checks, 'ok'),
    warn: count(checks, 'warn'),
    fail: count(checks, 'fail'),
    total: checks.length,
  }
}

function isReady(checks: DoctorCheck[], strict = false): boolean {
  return checks.length > 0 && (strict ? checks.every((c) => c.status === 'ok') : !checks.some((c) => c.status === 'fail'))
}

function report(mode: DoctorMode, strict: boolean, context: DoctorContext, checks: DoctorCheck[]): DoctorReport {
  return {
    command: 'doctor',
    mode,
    ready: isReady(checks, strict),
    strict,
    context,
    summary: summary(checks),
    checks,
  }
}

function buildAdminContext(checks: DoctorCheck[], adminToken?: string, headers?: Record<string, string>): AdminContext | undefined {
  try {
    return buildAdminClientCore({ adminToken, headers })
  } catch (err) {
    addCheck(checks, {
      section: 'health',
      check: 'admin config',
      status: 'fail',
      detail: message(err),
      advice: `Run \`${adminTokenProvisionCommand()}\` to provision local admin credentials.`,
    })
    return undefined
  }
}

function zoneLabel(zone: Zone): string {
  return `${zone.id} (${zone.name})`
}

async function runZoneChecks(ctx: AdminContext, zoneId: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const zoneCheck = await runCheck(
    checks,
    'zones',
    `${zoneId} lookup`,
    async () => zoneLabel(await ctx.client.zones.get(zoneId)),
    'Open the web console with `caracal web`, select Zones, and retry with a visible zone id.',
  )
  if (zoneCheck.status !== 'ok') return checks

  // The per-zone reads are independent admin queries; run them concurrently.
  const subChecks = await Promise.all([
    soloCheck(
      'zones',
      `${zoneId} resources`,
      async () => {
        const rows = await ctx.client.resources.list(zoneId)
        return rows.length === 0 ? 'none registered' : `${rows.length} registered`
      },
      'Check the resource API and database state for the selected zone.',
    ),
    soloCheck(
      'zones',
      `${zoneId} policy sets`,
      async () => {
        const rows = await ctx.client.policySets.list(zoneId)
        const active = rows.filter((row) => row.active_version_id).length
        return active === 0 ? `${rows.length} registered; none active` : `${active} active`
      },
      'Inspect policy-set activation state for the selected zone.',
    ),
    soloCheck(
      'zones',
      `${zoneId} audit query`,
      async () => {
        await ctx.client.audit.list(zoneId, { limit: 1 })
        return 'queryable'
      },
      'Inspect audit service and storage connectivity for the selected zone.',
    ),
  ])
  checks.push(...subChecks)
  return checks
}

async function runClockSkewCheck(checks: DoctorCheck[], apiUrl: string): Promise<void> {
  try {
    const target = normalizeHttpUrl(`${apiUrl}/health`, 'doctor probe')
    const before = Date.now()
    const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
    const after = Date.now()
    const dateHeader = res.headers?.get?.('date') ?? null
    if (!dateHeader) {
      addCheck(checks, {
        section: 'health',
        check: 'clock skew',
        status: 'warn',
        detail: 'api did not return a Date header; clock drift could not be measured',
        advice: 'Confirm the API emits a Date response header so operator clock drift can be checked.',
      })
      return
    }
    const serverMs = Date.parse(dateHeader)
    if (Number.isNaN(serverMs)) {
      addCheck(checks, { section: 'health', check: 'clock skew', status: 'warn', detail: `unparseable Date header: ${dateHeader}` })
      return
    }
    const roundTrip = after - before
    const localMidpoint = before + roundTrip / 2
    const rawSkew = Math.abs(serverMs - localMidpoint)
    const skew = Math.max(0, rawSkew - 1000 - roundTrip)
    const detail = `~${Math.round(skew / 1000)}s vs api (HTTP Date resolution ~1s)`
    if (skew >= CLOCK_SKEW_FAIL_MS) {
      addCheck(checks, {
        section: 'health',
        check: 'clock skew',
        status: 'fail',
        detail,
        advice:
          'Operator clock differs from the platform by more than 30s; token iat/nbf/exp validation and audit ordering will break. Sync the host clock with NTP.',
      })
      return
    }
    if (skew >= CLOCK_SKEW_WARN_MS) {
      addCheck(checks, {
        section: 'health',
        check: 'clock skew',
        status: 'warn',
        detail,
        advice: 'Operator clock drift detected; keep all hosts NTP-synced to avoid token timing and audit ordering issues.',
      })
      return
    }
    addCheck(checks, { section: 'health', check: 'clock skew', status: 'ok', detail })
  } catch (err) {
    addCheck(checks, {
      section: 'health',
      check: 'clock skew',
      status: 'warn',
      detail: message(err),
      advice: 'Could not measure clock skew; ensure the API is reachable.',
    })
  }
}

async function runHealthAndZoneChecks(
  checks: DoctorCheck[],
  ctx: AdminContext | undefined,
  zoneId: string | undefined,
): Promise<{ zoneScope: ZoneScope; zoneIds: string[] }> {
  const apiUrl = normalizeHttpUrl(ctx?.apiUrl ?? resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL), 'CARACAL_API_URL')
  await runCheck(
    checks,
    'health',
    'api health',
    async () => fetchOk(`${apiUrl}/health`),
    'Start the stack with `pnpm caracal up` or inspect API service logs.',
  )
  await runClockSkewCheck(checks, apiUrl)
  if (!ctx) return { zoneScope: 'none', zoneIds: [] }

  let zones: Zone[] = []
  const adminCheck = await runCheck(
    checks,
    'health',
    'admin auth',
    async () => {
      zones = await ctx.client.zones.list()
      return `${zones.length} zone(s) visible`
    },
    'Check CARACAL_ADMIN_TOKEN and the token issuer for admin API access.',
  )
  if (adminCheck.status !== 'ok') return { zoneScope: 'none', zoneIds: [] }

  if (zoneId) {
    checks.push(...(await runZoneChecks(ctx, zoneId)))
    return { zoneScope: 'selected', zoneIds: [zoneId] }
  }

  if (zones.length === 0) {
    addCheck(checks, {
      section: 'zones',
      check: 'zone inventory',
      status: 'warn',
      detail: 'No zones are visible to the current admin credentials.',
      advice: 'Create a zone or check admin token scope before provisioning resources.',
    })
    return { zoneScope: 'none', zoneIds: [] }
  }

  // Zones are independent; walk them concurrently and append per-zone results in
  // inventory order so the report scales with the slowest zone, not the sum of all.
  const zoneChecks = await Promise.all(zones.map((zone) => runZoneChecks(ctx, zone.id)))
  for (const group of zoneChecks) checks.push(...group)
  return { zoneScope: 'all', zoneIds: zones.map((zone) => zone.id) }
}

export async function runDoctorDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const strict = options.strict ?? false
  const preflightOnly = options.preflightOnly ?? false
  const localEnvironment = options.localEnvironment ?? true
  const mode: DoctorMode = preflightOnly ? 'preflight' : 'system'
  const checks: DoctorCheck[] = []
  let apiUrl = normalizeHttpUrl(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL), 'CARACAL_API_URL')
  let zoneId = options.zoneId
  let zoneScope: ZoneScope = preflightOnly ? 'none' : zoneId ? 'selected' : 'all'
  let zoneIds: string[] = preflightOnly ? [] : zoneId ? [zoneId] : []

  const preflightChecks: DoctorCheck[] = []
  if (!preflightOnly) {
    const ctx = buildAdminContext(checks, options.adminToken, options.headers)
    apiUrl = normalizeHttpUrl(ctx?.apiUrl ?? apiUrl, 'CARACAL_API_URL')
    zoneId = zoneId ?? ctx?.zoneId
    // The health/zone walk, the service probes, and the local preflight touch disjoint
    // targets; run them concurrently into separate buffers and merge in section order so
    // the report stays deterministic while total latency tracks the slowest branch. The
    // local runtime-environment preflight only runs on a data-plane host that owns those
    // values; a control-plane vantage skips it rather than fail on secrets it never holds.
    const serviceChecks: DoctorCheck[] = []
    const [zoneResult] = await Promise.all([
      runHealthAndZoneChecks(checks, ctx, zoneId),
      runServiceChecks(serviceChecks, apiUrl, { skipUnsetServices: !localEnvironment, probeMetrics: localEnvironment }),
      localEnvironment ? runPreflightSection(preflightChecks) : Promise.resolve(),
    ])
    zoneScope = zoneResult.zoneScope
    zoneIds = zoneResult.zoneIds
    checks.push(...serviceChecks)
  } else {
    await runPreflightSection(preflightChecks)
  }
  checks.push(...preflightChecks)

  return report(mode, strict, { apiUrl, zoneScope, zoneIds }, checks)
}

export function doctorShouldFail(report: DoctorReport): boolean {
  return !report.ready
}
