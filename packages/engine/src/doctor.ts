// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared doctor diagnostics for terminal operator health checks.

import type { Zone } from '@caracalai/admin'
import { discoverCoordinatorToken } from '@caracalai/core'
import { DEFAULT_API_URL, DEFAULT_COORDINATOR_URL, DEFAULT_ZONE_URL, resolveServiceUrl, type RuntimeConfig } from './runtimeConfig.js'
import { scrubTokens } from './crash.js'
import { buildAdminClient as buildAdminClientCore, type AdminContext } from './shared.js'
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
  cfg?: RuntimeConfig
  zoneId?: string
  strict?: boolean
  preflightOnly?: boolean
}

interface ServiceTarget {
  name: string
  baseUrl: string
  metricsPath?: string
  summarizeMetrics?: (value: unknown) => string
}

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

function summarizeSTS(value: unknown): string {
  const compileErrors = nestedNumber(value, ['opa', 'compile_errors'])
  const evalErrors = nestedNumber(value, ['opa', 'eval_errors'])
  const maxPolicyAge = nestedNumber(value, ['opa', 'max_policy_age_seconds'])
  return `opa compile_errors=${compileErrors ?? '-'} eval_errors=${evalErrors ?? '-'} max_policy_age_seconds=${maxPolicyAge ?? '-'}`
}

function summarizeGateway(value: unknown): string {
  const bindings = nestedNumber(value, ['bindings_loaded'])
  const revocations = nestedNumber(value, ['revocations_active'])
  const denied = nestedNumber(value, ['requests_denied'])
  return `bindings=${bindings ?? '-'} revocations=${revocations ?? '-'} denied=${denied ?? '-'}`
}

function summarizeAudit(value: unknown): string {
  const lag = nestedNumber(value, ['consumer_lag'])
  const dlq = nestedNumber(value, ['dlq_size'])
  const tamper = nestedNumber(value, ['tamper_mismatch_total'])
  return `consumer_lag=${lag ?? '-'} dlq_size=${dlq ?? '-'} tamper_mismatch_total=${tamper ?? '-'}`
}

function summarizeCoordinator(value: unknown): string {
  const outboxDead = nestedNumber(value, ['outbox', 'dead'])
  const outboxPending = nestedNumber(value, ['outbox', 'pending'])
  const invocationsRunning = nestedNumber(value, ['invocations', 'running'])
  return `outbox_pending=${outboxPending ?? '-'} outbox_dead=${outboxDead ?? '-'} invocations_running=${invocationsRunning ?? '-'}`
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
  summarizeMetrics: (value: unknown) => string,
): ServiceTarget | undefined {
  try {
    return { name, baseUrl: serviceUrl(envKeys, devDefault), metricsPath, summarizeMetrics }
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

async function runCoordinatorMetrics(checks: DoctorCheck[], target: ServiceTarget): Promise<void> {
  const headers = coordinatorTokenHeaders()
  try {
    const body = await fetchJSON(`${target.baseUrl}${target.metricsPath}`, headers)
    addCheck(checks, {
      section: 'readiness',
      check: 'coordinator metrics',
      status: 'ok',
      detail: target.summarizeMetrics ? target.summarizeMetrics(body) : 'queryable',
    })
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
    serviceTarget(checks, 'sts', ['CARACAL_STS_URL', 'CARACAL_ZONE_URL'], DEFAULT_ZONE_URL, '/metrics.json', summarizeSTS),
    serviceTarget(checks, 'gateway', ['CARACAL_GATEWAY_URL'], 'http://localhost:8081', '/metrics.json', summarizeGateway),
    serviceTarget(checks, 'audit', ['CARACAL_AUDIT_URL'], 'http://localhost:9090', '/metrics.json', summarizeAudit),
    serviceTarget(checks, 'coordinator', ['CARACAL_COORDINATOR_URL'], DEFAULT_COORDINATOR_URL, '/stats', summarizeCoordinator),
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
      await runCheck(checks, 'readiness', `${target.name} metrics`, async () => {
        const body = await fetchJSON(`${target.baseUrl}${target.metricsPath}`)
        return target.summarizeMetrics ? target.summarizeMetrics(body) : 'queryable'
      }, `Confirm ${target.name} exposes operator metrics on ${target.metricsPath}.`)
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

function buildAdminContext(checks: DoctorCheck[], cfg?: RuntimeConfig): AdminContext | undefined {
  try {
    return buildAdminClientCore(cfg)
  } catch (err) {
    addCheck(checks, {
      section: 'health',
      check: 'admin config',
      status: 'fail',
      detail: message(err),
      advice: 'Set CARACAL_ADMIN_TOKEN or run `pnpm caracal up` to provision local admin credentials.',
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
    'Open `pnpm caracal terminal`, select Zones, and retry with a visible zone id.',
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
  await runCheck(checks, 'zones', `${zoneId} grants`, async () => {
    const rows = await ctx.client.grants.list(zoneId)
    return rows.length === 0 ? 'none active' : `${rows.length} visible`
  }, 'Inspect grants for the selected zone and confirm admin scope access.')
  await runCheck(checks, 'zones', `${zoneId} audit query`, async () => {
    await ctx.client.audit.list(zoneId, { limit: 1 })
    return 'queryable'
  }, 'Inspect audit service and storage connectivity for the selected zone.')
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
    const ctx = buildAdminContext(checks, options.cfg)
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
