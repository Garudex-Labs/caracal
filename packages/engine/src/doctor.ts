// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared doctor diagnostics for Console operator health checks.

import type { Zone } from '@caracalai/admin'
import { discoverCoordinatorToken } from '@caracalai/core'
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

function message(err: unknown): string {
  return scrubTokens(err instanceof Error ? err.message : String(err))
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
    return { detail, status: 'fail', advice: 'STS cannot compile a policy bundle; token exchanges may deny or run on a stale bundle. Inspect the active policy set version and STS logs.' }
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
    return { detail, status: 'fail', advice: 'Audit chain integrity failure detected (tamper mismatch or chain break). Treat as a security incident: preserve evidence and investigate audit writers and key consistency.' }
  }
  if ((hmacFailures ?? 0) > 0) {
    return { detail, status: 'warn', advice: 'Audit HMAC verification failures detected; verify AUDIT_HMAC_KEY is identical across every audit writer.' }
  }
  if ((dlq ?? 0) > 0) {
    return { detail, status: 'warn', advice: 'Audit events are landing in the dead-letter queue; inspect parse or processing failures before they age out.' }
  }
  if ((lag ?? 0) > AUDIT_LAG_WARN) {
    return { detail, status: 'warn', advice: 'Audit consumer is lagging; recorded events may be delayed. Check audit consumer throughput and stream backlog.' }
  }
  return { detail, status: 'ok' }
}

function evaluateCoordinator(value: unknown): MetricEvaluation {
  const outboxDead = nestedNumber(value, ['outbox', 'dead'])
  const outboxPending = nestedNumber(value, ['outbox', 'pending'])
  const invocationsRunning = nestedNumber(value, ['invocations', 'running'])
  const detail = `outbox_pending=${outboxPending ?? '-'} outbox_dead=${outboxDead ?? '-'} invocations_running=${invocationsRunning ?? '-'}`
  if ((outboxDead ?? 0) > 0) {
    return { detail, status: 'warn', advice: 'Coordinator outbox has dead rows; spawn or revocation events failed delivery. Inspect and requeue the dead outbox rows.' }
  }
  if ((outboxPending ?? 0) > OUTBOX_PENDING_WARN) {
    return { detail, status: 'warn', advice: 'Coordinator outbox backlog is high; downstream propagation may be delayed. Confirm the outbox processor is running.' }
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

async function fetchOk(url: string, headers?: ProbeHeaders): Promise<string> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}${await failureReason(res)}`)
  return target
}

async function fetchJSON(url: string, headers?: ProbeHeaders): Promise<unknown> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error', headers })
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
    for (const key of ['reason', 'error', 'detail']) {
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
): ServiceTarget | undefined {
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

async function runCoordinatorMetrics(checks: DoctorCheck[], target: ServiceTarget): Promise<void> {
  const headers = coordinatorTokenHeaders()
  try {
    await runMetricsCheck(checks, target, headers)
  } catch (err) {
    const detail = message(err)
    if (!headers && /^HTTP 401\b/.test(detail)) {
      addCheck(checks, {
        section: 'readiness',
        check: 'coordinator metrics',
        status: 'warn',
        detail: 'protected; managed coordinator token not found',
        advice: 'Run `caracal up` to generate and mount the coordinator operator token.',
      })
      return
    }
    addCheck(checks, {
      section: 'readiness',
      check: 'coordinator metrics',
      status: 'fail',
      detail,
      advice: 'Confirm coordinator exposes authenticated operator metrics on /stats.',
    })
  }
}

async function runServiceChecks(checks: DoctorCheck[], apiUrl: string): Promise<void> {
  const targets = [
    { name: 'api', baseUrl: apiUrl },
    serviceTarget(checks, 'sts', ['CARACAL_STS_URL', 'CARACAL_ZONE_URL'], DEFAULT_ZONE_URL, '/metrics.json', evaluateSTS),
    serviceTarget(checks, 'gateway', ['CARACAL_GATEWAY_URL'], DEFAULT_GATEWAY_URL, '/metrics.json', evaluateGateway),
    serviceTarget(checks, 'audit', ['CARACAL_AUDIT_URL'], 'http://localhost:9090', '/metrics.json', evaluateAudit),
    serviceTarget(checks, 'coordinator', ['CARACAL_COORDINATOR_URL'], DEFAULT_COORDINATOR_URL, '/stats', evaluateCoordinator),
  ].filter((target): target is ServiceTarget => target !== undefined)
  for (const target of targets) {
    await runCheck(
      checks,
      'readiness',
      `${target.name} readiness`,
      async () => fetchOk(`${target.baseUrl}/ready`),
      `Inspect ${target.name} logs and confirm the service is bound to ${target.baseUrl}.`,
    )
    if (target.metricsPath) {
      if (target.name === 'coordinator') {
        await runCoordinatorMetrics(checks, target)
        continue
      }
      try {
        await runMetricsCheck(checks, target)
      } catch (err) {
        addCheck(checks, {
          section: 'readiness',
          check: `${target.name} metrics`,
          status: 'fail',
          detail: message(err),
          advice: `Confirm ${target.name} exposes operator metrics on ${target.metricsPath}.`,
        })
      }
    }
  }
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

function buildAdminContext(checks: DoctorCheck[]): AdminContext | undefined {
  try {
    return buildAdminClientCore()
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

async function runZoneChecks(checks: DoctorCheck[], ctx: AdminContext, zoneId: string): Promise<void> {
  const zoneCheck = await runCheck(
    checks,
    'zones',
    `${zoneId} lookup`,
    async () => zoneLabel(await ctx.client.zones.get(zoneId)),
    'Open `pnpm caracal console`, select Zones, and retry with a visible zone id.',
  )
  if (zoneCheck.status !== 'ok') return

  await runCheck(checks, 'zones', `${zoneId} resources`, async () => {
    const rows = await ctx.client.resources.list(zoneId)
    return rows.length === 0 ? 'none registered' : `${rows.length} registered`
  }, 'Check the resource API and database state for the selected zone.')
  await runCheck(checks, 'zones', `${zoneId} policy sets`, async () => {
    const rows = await ctx.client.policySets.list(zoneId)
    const active = rows.filter((row) => row.active_version_id).length
    return active === 0 ? `${rows.length} registered; none active` : `${active} active`
  }, 'Inspect policy-set activation state for the selected zone.')
  await runCheck(checks, 'zones', `${zoneId} audit query`, async () => {
    await ctx.client.audit.list(zoneId, { limit: 1 })
    return 'queryable'
  }, 'Inspect audit service and storage connectivity for the selected zone.')
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
        advice: 'Operator clock differs from the platform by more than 30s; token iat/nbf/exp validation and audit ordering will break. Sync the host clock with NTP.',
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
    await runZoneChecks(checks, ctx, zoneId)
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

  for (const zone of zones) await runZoneChecks(checks, ctx, zone.id)
  return { zoneScope: 'all', zoneIds: zones.map((zone) => zone.id) }
}

export async function runDoctorDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const strict = options.strict ?? false
  const preflightOnly = options.preflightOnly ?? false
  const mode: DoctorMode = preflightOnly ? 'preflight' : 'system'
  const checks: DoctorCheck[] = []
  let apiUrl = normalizeHttpUrl(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL), 'CARACAL_API_URL')
  let zoneId = options.zoneId
  let zoneScope: ZoneScope = preflightOnly ? 'none' : zoneId ? 'selected' : 'all'
  let zoneIds: string[] = preflightOnly ? [] : zoneId ? [zoneId] : []

  if (!preflightOnly) {
    const ctx = buildAdminContext(checks)
    apiUrl = normalizeHttpUrl(ctx?.apiUrl ?? apiUrl, 'CARACAL_API_URL')
    zoneId = zoneId ?? ctx?.zoneId
    const zoneResult = await runHealthAndZoneChecks(checks, ctx, zoneId)
    zoneScope = zoneResult.zoneScope
    zoneIds = zoneResult.zoneIds
    await runServiceChecks(checks, apiUrl)
  }
  await runPreflightSection(checks)

  return report(mode, strict, { apiUrl, zoneScope, zoneIds }, checks)
}

export function doctorShouldFail(report: DoctorReport): boolean {
  return !report.ready
}
