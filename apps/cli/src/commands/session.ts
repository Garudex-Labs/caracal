// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal session …` admin subcommands (read-only; revocation is a side effect of grant.revoke).

import type { CliConfig } from '../config.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagInt,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
} from './shared.ts'

export async function sessionCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.sessions.list(zoneId, {
          status: flagString(flags, 'status') as 'active' | 'revoked' | 'expired' | undefined,
          subject_id: flagString(flags, 'subject'),
          limit: flagInt(flags, 'limit'),
        })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'session_type', 'subject_id', 'status', 'expires_at', 'authenticated_at'])
      }
      default:
        return usage('session list [--zone …] [--status active|revoked|expired] [--subject …] [--limit N]')
    }
  } catch (err) {
    fail(err)
  }
}

function usage(line: string): void {
  process.stderr.write(`Usage: caracal ${line}\n`)
  process.exit(1)
}
