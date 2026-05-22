// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal credential …`: reads scoped resource tokens and inspects JWT claims.

import { readFileSync } from 'node:fs'
import { credentialRead } from '@caracalai/engine'
import { scrubTokens } from '@caracalai/engine/crash'
import type { CliConfig } from '../config.ts'
import { printError } from '../style.ts'
import {
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  showHelp,
  unknownVerb,
} from './shared.ts'

interface TokenInspection {
  verified: false
  summary: Record<string, string | number>
  header: Record<string, unknown>
  claims: Record<string, unknown>
}

type TokenStatus = 'active' | 'expired' | 'not_yet_valid' | 'missing_expiry'

export async function credentialCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  switch (verb) {
    case 'read':
      if (rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') return readHelp()
      if (!cfg) {
        printError('caracal.toml not found; credential read needs zone_url, zone_id, application_id, and app_client_secret. Use `caracal credential inspect` for offline token inspection.')
        process.exit(1)
      }
      return credentialReadCommand(rest[0] ?? '', cfg)
    case 'inspect':
      return credentialInspectCommand(rest)
    case 'help':
    case '--help':
    case '-h':
      return help()
    default:
      return unknownVerb('credential', verb, help)
  }
}

export async function credentialReadCommand(resource: string, cfg: CliConfig): Promise<void> {
  if (!resource) {
    printError('Usage: caracal credential read <resource>')
    process.exit(1)
  }
  try {
    const token = await credentialRead({ cfg, resource })
    process.stdout.write(token + '\n')
  } catch (err) {
    const desc = scrubTokens(err instanceof Error ? err.message : String(err))
    process.stderr.write(JSON.stringify({ resource, reason: desc }) + '\n')
    process.exit(1)
  }
}

export function credentialInspectCommand(argv: string[]): void {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return inspectHelp()
  const { positional, flags } = parseArgs(argv)
  const json = flagBool(flags, 'json')
  try {
    const inspection = inspectToken(readToken(positional[0], flags))
    if (json) return printJSON(inspection)
    printTable([inspection.summary], [
      'verification',
      'status',
      'issuer',
      'subject',
      'zone',
      'session',
      'agent_run',
      'delegated_permission',
      'resource',
      'scopes',
      'expires_at',
      'seconds_until_expiry',
      'algorithm',
      'key_id',
      'token_id',
    ])
  } catch (err) {
    fail(err)
  }
}

function readToken(positional: string | undefined, flags: Record<string, string | boolean>): string {
  const flagToken = flagString(flags, 'token')
  const file = flagString(flags, 'file')
  const sources = [positional, flagToken, file].filter((value) => typeof value === 'string' && value !== '')
  if (sources.length > 1) {
    throw new Error('provide exactly one token source: positional token, --token, --file, or - for stdin')
  }
  if (file) return readFileSync(file, 'utf8').trim()
  const source = flagToken ?? positional
  if (source === '-') return readFileSync(0, 'utf8').trim()
  if (source) return source.trim()
  throw new Error('Usage: caracal credential inspect <jwt>|--token <jwt>|--file <path>|- [--json]')
}

function inspectToken(token: string): TokenInspection {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new Error('invalid JWT: expected three non-empty base64url segments')
  }
  const header = decodeSegment(parts[0]!, 'header')
  const claims = decodeSegment(parts[1]!, 'claims')
  const now = Math.floor(Date.now() / 1000)
  const exp = numberClaim(claims, 'exp')
  const nbf = numberClaim(claims, 'nbf')
  const iat = numberClaim(claims, 'iat')
  const resource = claimList(claims, 'target') ?? claimList(claims, 'resource') ?? claimList(claims, 'aud')
  const scopes = claimList(claims, 'scope') ?? claimList(claims, 'scp')
  const summary: Record<string, string | number> = {
    verification: 'not_verified',
    status: tokenStatus(now, exp, nbf),
    issuer: stringClaim(claims, 'iss') ?? '-',
    subject: stringClaim(claims, 'sub') ?? '-',
    audience: (claimList(claims, 'aud') ?? ['-']).join(','),
    zone: stringClaim(claims, 'zone_id') ?? '-',
    session: stringClaim(claims, 'root_sid') ?? stringClaim(claims, 'session_id') ?? stringClaim(claims, 'sid') ?? '-',
    agent_run: stringClaim(claims, 'agent_session_id') ?? '-',
    delegated_permission: stringClaim(claims, 'delegation_edge_id') ?? '-',
    resource: resource?.join(',') ?? '-',
    scopes: scopes?.join(' ') ?? '-',
    issued_at: iat !== undefined ? new Date(iat * 1000).toISOString() : '-',
    not_before: nbf !== undefined ? new Date(nbf * 1000).toISOString() : '-',
    expires_at: exp !== undefined ? new Date(exp * 1000).toISOString() : '-',
    seconds_until_expiry: exp !== undefined ? exp - now : '-',
    algorithm: stringClaim(header, 'alg') ?? '-',
    key_id: stringClaim(header, 'kid') ?? '-',
    token_id: stringClaim(claims, 'jti') ?? '-',
  }
  return { verified: false, summary, header, claims }
}

function decodeSegment(segment: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name} segment is not a JSON object`)
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid JWT ${name} segment: ${reason}`)
  }
}

function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberClaim(claims: Record<string, unknown>, key: string): number | undefined {
  const value = claims[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function claimList(claims: Record<string, unknown>, key: string): string[] | undefined {
  const value = claims[key]
  if (Array.isArray(value)) {
    const list = value.filter((item): item is string => typeof item === 'string' && item !== '')
    return list.length > 0 ? list : undefined
  }
  if (typeof value === 'string' && value !== '') return value.split(/\s+/).filter(Boolean)
  return undefined
}

function tokenStatus(now: number, exp: number | undefined, nbf: number | undefined): TokenStatus {
  if (nbf !== undefined && now < nbf) return 'not_yet_valid'
  if (exp === undefined) return 'missing_expiry'
  return now >= exp ? 'expired' : 'active'
}

function help(): never {
  return showHelp(
    [
      'Usage: caracal credential <verb> [options]',
      '',
      'Verbs:',
      '  read <resource>       Exchange app credentials for a scoped Caracal access token',
      '  inspect <jwt>|-       Decode a JWT locally without verifying its signature',
      '',
      'See `caracal credential inspect --help` for token-inspection sources.',
      '',
    ],
  )
}

function readHelp(): never {
  return showHelp(
    [
      'Usage: caracal credential read <resource>',
      '',
      'Exchanges app credentials from caracal.toml for a scoped Caracal access token.',
      '',
    ],
  )
}

function inspectHelp(): never {
  return showHelp(
    [
      'Usage: caracal credential inspect <jwt>|--token <jwt>|--file <path>|- [--json]',
      '',
      'Decodes a JWT header and claims locally. The command does not verify the signature; use it to inspect issuer, subject, zone, scopes, resources, sessions, expiry, and key id during triage.',
      '',
      'Sources:',
      '  <jwt>                  Token as a positional argument',
      '  --token <jwt>          Token as a flag value',
      '  --file <path>          Read token from a file',
      '  -                      Read token from stdin',
      '',
      'Flags:',
      '  --json                 Emit decoded header, claims, and summary',
      '  --help, -h             Show this help',
      '',
    ],
  )
}
