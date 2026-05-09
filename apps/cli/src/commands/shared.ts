// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared helpers for admin-surface CLI subcommands: client bootstrap and IO.

import { readFileSync } from 'node:fs'
import { AdminClient, AdminApiError } from '@caracalai/admin'
import { discoverAdminToken } from '@caracalai/core'
import type { CliConfig } from '../config.ts'

const DEFAULT_API_URL = 'http://localhost:3000'
const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'

export { discoverAdminToken }

export interface AdminContext {
  client: AdminClient
  zoneId: string | undefined
}

export function buildAdminClient(cfg?: CliConfig): AdminContext {
  const adminToken = discoverAdminToken()
  if (!adminToken) {
    process.stderr.write(
      'Error: CARACAL_ADMIN_TOKEN not set; export it or add it to infra/docker/.env\n',
    )
    process.exit(1)
  }
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const coordinatorToken = process.env.CARACAL_COORDINATOR_TOKEN
  const zoneId = process.env.CARACAL_ZONE_ID ?? cfg?.zone_id
  return {
    client: new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken }),
    zoneId,
  }
}

// resolveServiceUrl falls back to the dev default only in development. In any other
// environment, it requires the env var to be set so a misconfigured production CLI
// fails loudly instead of silently hammering localhost.
function resolveServiceUrl(envKey: string, devDefault: string): string {
  const v = process.env[envKey]
  if (v) return v
  const env = process.env.NODE_ENV ?? 'development'
  if (env !== 'development') {
    process.stderr.write(`Error: ${envKey} is required when NODE_ENV=${env}\n`)
    process.exit(1)
  }
  return devDefault
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
    process.stderr.write('Error: --zone <id> required (or set CARACAL_ZONE_ID, or add zone_id to caracal.toml)\n')
    process.exit(1)
  }
  return zoneId
}

export function fail(err: unknown): never {
  if (err instanceof AdminApiError) {
    process.stderr.write(`Error: ${err.code} (HTTP ${err.status})\n`)
    if (err.body && typeof err.body === 'object') {
      process.stderr.write(JSON.stringify(err.body, null, 2) + '\n')
    } else if (err.body) {
      process.stderr.write(String(err.body) + '\n')
    }
  } else {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
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
    process.stdout.write('(no rows)\n')
    return
  }
  const cells = rows.map((row) => columns.map((c) => formatCell(row[c])))
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)))
  process.stdout.write(columns.map((c, i) => pad(c, widths[i]!)).join('  ') + '\n')
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n')
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

export function readContent(value: string | undefined): string {
  if (!value) {
    process.stderr.write('Error: missing content; use --file <path> or --content <inline>\n')
    process.exit(1)
  }
  if (value.startsWith('@')) {
    return readFileSync(value.slice(1), 'utf8')
  }
  return value
}
