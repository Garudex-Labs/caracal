// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal doctor` reports operator diagnostics for the local Caracal control plane.

import type { CliConfig } from '../config.ts'
import type { Zone } from '@caracalai/admin'
import { buildAdminClient as buildAdminClientCore, type AdminContext } from '@caracalai/engine'
import { scrubTokens } from '@caracalai/engine/crash'
import { DEFAULT_API_URL, DEFAULT_COORDINATOR_URL, DEFAULT_ZONE_URL, resolveServiceUrl } from '@caracalai/engine/cli'
import {
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  showHelp,
} from './shared.ts'
import { runPreflightChecks, type PreflightCheck } from './preflight.ts'
import { style, SYMBOL } from '../style.ts'

type DoctorStatus = 'ok' | 'warn' | 'fail'
type DoctorMode = 'system' | 'preflight'
type DoctorSection = 'health' | 'readiness' | 'zones' | 'preflight'
type ZoneScope = 'all' | 'selected' | 'none'

interface DoctorCheck {
  section: DoctorSection
  check: string
  status: DoctorStatus
  detail: string
  advice?: string
}

interface DoctorSummary {
  ok: number
  warn: number
  fail: number
  total: number
}

interface DoctorContext {
  apiUrl: string
  zoneScope: ZoneScope
  zoneIds: string[]
}

interface DoctorReport {
  command: 'doctor'
  mode: DoctorMode
  ready: boolean
  strict: boolean
  context: DoctorContext
  summary: DoctorSummary
  checks: DoctorCheck[]
}

interface ServiceTarget {
  name: string
  baseUrl: string
  metricsPath?: string
  summarizeMetrics?: (value: unknown) => string
}

const FETCH_TIMEOUT_MS = 5000
const SECTION_LABELS: Record<DoctorSection, string> = {
  health: 'System health',
  readiness: 'Service readiness',
  zones: 'Zone diagnostics',
  preflight: 'Local preflight',
}
const SECTION_ORDER: DoctorSection[] = ['health', 'readiness', 'zones', 'preflight']

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

async function fetchOk(url: string): Promise<string> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
  if (!res.ok) throw new Error(`HTTP ${res.status}${await failureReason(res)}`)
  return target
}

async function fetchJSON(url: string): Promise<unknown> {
  const target = normalizeHttpUrl(url, 'doctor probe')
  const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
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

function isReady(checks: DoctorCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.status === 'ok')
}

function hasFailed(checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.status === 'fail')
}

function shouldFail(checks: DoctorCheck[], strict: boolean): boolean {
  return hasFailed(checks) || (strict && !isReady(checks))
}

function statusText(status: DoctorStatus): string {
  if (status === 'ok') return style.success(`${SYMBOL.ok} ok`.padEnd(8))
  if (status === 'warn') return style.warn(`${SYMBOL.warn} warn`.padEnd(8))
  return style.error(`${SYMBOL.fail} fail`.padEnd(8))
}

function healthLabel(report: DoctorReport): string {
  if (report.summary.fail > 0) return style.error('unhealthy')
  if (report.summary.warn > 0) return style.warn('attention')
  return style.success('healthy')
}

function modeLabel(mode: DoctorMode): string {
  if (mode === 'system') return 'complete system check'
  return 'local preflight only'
}

function uniqueAdvice(checks: DoctorCheck[]): string[] {
  return [...new Set(checks.flatMap((check) => check.advice ? [check.advice] : []))]
}

function printHuman(report: DoctorReport): void {
  process.stdout.write(`${style.title('Caracal doctor')} ${style.label(`(${modeLabel(report.mode)})`)}\n`)
  process.stdout.write(`${style.label('api:')} ${style.code(report.context.apiUrl)}\n`)
  const zones = report.context.zoneIds.length === 0
    ? 'none'
    : report.context.zoneScope === 'all'
      ? `all visible (${report.context.zoneIds.join(', ')})`
      : report.context.zoneIds.join(', ')
  process.stdout.write(`${style.label('zones:')} ${zones === 'none' ? style.label(zones) : style.code(zones)}\n`)
  process.stdout.write(
    `${style.label('summary:')} ${healthLabel(report)} ` +
      `${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (${report.summary.total} checks)\n`,
  )
  process.stdout.write(`${style.label('readiness:')} ${report.ready ? style.success('ready') : style.warn('not ready')}${report.strict ? style.label(' (strict)') : ''}\n`)

  const width = Math.max(5, ...report.checks.map((c) => c.check.length))
  for (const section of SECTION_ORDER) {
    const checks = report.checks.filter((c) => c.section === section)
    if (checks.length === 0) continue
    process.stdout.write(`\n${style.header(SECTION_LABELS[section])}\n`)
    process.stdout.write(`  ${style.header('status'.padEnd(8))}  ${style.header('check'.padEnd(width))}  ${style.header('detail')}\n`)
    for (const check of checks) {
      process.stdout.write(`  ${statusText(check.status)}  ${check.check.padEnd(width)}  ${check.detail}\n`)
    }
  }

  const advice = uniqueAdvice(report.checks)
  if (advice.length > 0) {
    process.stdout.write(`\n${style.header('Next actions')}\n`)
    for (const item of advice) process.stdout.write(`  ${SYMBOL.step} ${item}\n`)
  }
}

function report(mode: DoctorMode, strict: boolean, context: DoctorContext, checks: DoctorCheck[]): DoctorReport {
  return {
    command: 'doctor',
    mode,
    ready: isReady(checks),
    strict,
    context,
    summary: summary(checks),
    checks,
  }
}

function buildAdminContext(checks: DoctorCheck[], cfg?: CliConfig): AdminContext | undefined {
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
    'Run `pnpm caracal zone list` and retry with a visible zone id.',
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

export async function doctorCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return help()
  const { flags } = parseArgs(argv)
  const json = flagBool(flags, 'json')
  const strict = flagBool(flags, 'ready')
  const preflightOnly = flagBool(flags, 'preflight')
  const mode: DoctorMode = preflightOnly ? 'preflight' : 'system'
  const checks: DoctorCheck[] = []
  let body: DoctorReport

  try {
    let ctx: AdminContext | undefined
    let apiUrl = normalizeHttpUrl(resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL), 'CARACAL_API_URL')
    let zoneId = flagString(flags, 'zone')
    let zoneScope: ZoneScope = preflightOnly ? 'none' : zoneId ? 'selected' : 'all'
    let zoneIds: string[] = preflightOnly ? [] : zoneId ? [zoneId] : []

    if (!preflightOnly) {
      ctx = buildAdminContext(checks, cfg)
      apiUrl = normalizeHttpUrl(ctx?.apiUrl ?? apiUrl, 'CARACAL_API_URL')
      zoneId = zoneId ?? ctx?.zoneId
      const zoneResult = await runHealthAndZoneChecks(checks, ctx, zoneId)
      zoneScope = zoneResult.zoneScope
      zoneIds = zoneResult.zoneIds
      await runServiceChecks(checks, apiUrl)
    }
    await runPreflightSection(checks)

    body = report(mode, strict, { apiUrl, zoneScope, zoneIds }, checks)
  } catch (err) {
    fail(err)
  }

  if (json) {
    printJSON(body)
  } else {
    printHuman(body)
  }
  if (shouldFail(checks, strict)) process.exit(1)
}

function help(): never {
  return showHelp([
    style.header('Usage'),
    `  caracal doctor ${style.label('[--zone <id>] [--preflight] [--ready] [--json]')}`,
    '',
    style.header('Checks'),
    `  ${style.success(SYMBOL.ok)} health, readiness, zones, and local preflight`,
    `  ${SYMBOL.step} no --zone: inspect every visible zone`,
    '',
    style.header('Flags'),
    `  ${style.code('--zone <id>')}    inspect one zone`,
    `  ${style.code('--preflight')}    local config/secrets/dependencies only`,
    `  ${style.code('--ready')}        strict gate: warnings fail readiness`,
    `  ${style.code('--json')}         structured output`,
    '',
    style.label('Exit 1 on failed checks; --ready also exits 1 on warnings.'),
    '',
  ])
}
