// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI flag parsing, table/JSON printers, and exit-code handling for admin subcommands.

import { AdminApiError } from '@caracalai/admin'
import { scrubTokens } from '@caracalai/engine/crash'
import {
  buildAdminClient as buildAdminClientCore,
  readContent as readContentCore,
  type AdminContext,
} from '@caracalai/engine'
import type { CliConfig } from '../config.ts'
import { style, printError } from '../style.ts'
import { isReplExit } from '../repl.ts'

export type { AdminContext } from '@caracalai/engine'

export function buildAdminClient(cfg?: CliConfig): AdminContext {
  try {
    return buildAdminClientCore(cfg)
  } catch (err) {
    if (isReplExit(err)) throw err
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export function readContent(value: string | undefined): string {
  try {
    return readContentCore(value)
  } catch (err) {
    if (isReplExit(err)) throw err
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = true
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

export function flagInt(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagString(flags, key)
  if (!v) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

export function flagList(flags: Record<string, string | boolean>, key: string): string[] | undefined {
  const v = flagString(flags, key)
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined
}

export function requireZone(ctx: AdminContext, flags: Record<string, string | boolean>): string {
  const zoneId = flagString(flags, 'zone') ?? ctx.zoneId
  if (!zoneId) {
    printError('--zone <id> required (or set CARACAL_ZONE_ID, or add zone_id to caracal.toml)')
    process.exit(1)
  }
  return zoneId
}

export function usage(line: string): never {
  process.stderr.write(`${style.label('Usage:')} caracal ${line}\n`)
  process.exit(1)
}

export function showHelp(lines: readonly string[]): never {
  process.stdout.write(lines.join('\n'))
  process.exit(0)
}

export function unknownVerb(group: string, verb: string | undefined, help: () => void): never {
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    help()
    process.exit(0)
  }
  printError(`unknown ${group} verb '${verb}'`)
  help()
  process.exit(1)
}

function remediationHint(status: number): string | undefined {
  if (status === 401) {
    return 'Check CARACAL_ADMIN_TOKEN, or the app_client_secret in caracal.toml. Multi-agent commands require CARACAL_COORDINATOR_TOKEN.'
  }
  if (status === 403) {
    return 'Current credentials lack the required scope or zone access. Verify the zone selector and the token issuer.'
  }
  if (status === 404) {
    return 'Target not found. Run caracal zone list / caracal app list / caracal resource list to confirm the id.'
  }
  if (status === 409) {
    return 'Conflict — the object changed concurrently. Re-fetch with caracal <noun> get <id> and retry.'
  }
  if (status === 422) {
    return 'Validation failed. Inspect the body below and correct the offending fields.'
  }
  if (status === 429) {
    return 'Rate limited. Back off and retry; check operator metrics with caracal doctor --extended.'
  }
  if (status >= 500) {
    return 'Server error. Probe service readiness with caracal doctor --extended; then check service logs.'
  }
  return undefined
}

function extractRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  for (const key of ['requestId', 'request_id']) {
    const v = b[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export function fail(err: unknown): never {
  if (isReplExit(err)) throw err
  if (err instanceof AdminApiError) {
    printError(`${err.code} (HTTP ${err.status})`)
    const hint = remediationHint(err.status)
    if (hint) process.stderr.write(`  → ${hint}\n`)
    const requestId = extractRequestId(err.body)
    if (requestId) {
      process.stderr.write(`  → request_id: ${requestId}\n`)
      process.stderr.write(`  → caracal explain ${requestId}\n`)
    }
    if (err.body && typeof err.body === 'object') {
      process.stderr.write(scrubTokens(JSON.stringify(err.body, null, 2)) + '\n')
    } else if (err.body) {
      process.stderr.write(scrubTokens(String(err.body)) + '\n')
    }
  } else {
    printError(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}

export function printJSON(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

export function printTable(rows: readonly object[], columns: readonly string[]): void {
  const r = rows as readonly Record<string, unknown>[]
  return printTableImpl(r, columns)
}

function printTableImpl(rows: readonly Record<string, unknown>[], columns: readonly string[]): void {
  if (rows.length === 0) {
    process.stdout.write(style.label('(no rows)') + '\n')
    return
  }
  const cells = rows.map((row) => columns.map((c) => formatCell(row[c])))
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)))
  process.stdout.write(
    style.header(columns.map((c, i) => pad(c, widths[i]!)).join('  ')) + '\n',
  )
  process.stdout.write(style.label(widths.map((w) => '-'.repeat(w)).join('  ')) + '\n')
  for (const row of cells) {
    process.stdout.write(row.map((v, i) => pad(v, widths[i]!)).join('  ') + '\n')
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) return value.join(',')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
