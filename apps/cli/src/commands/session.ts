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
  showHelp,
  unknownVerb,
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
      case 'help':
      case '--help':
      case '-h':
        return help()
      default:
        return unknownVerb('session', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): never {
  return showHelp(
    [
      'Usage: caracal session list [options]',
      '',
      'Lists sessions within a zone (read-only; revocation is done via `caracal grant revoke`).',
      '',
      'Flags:',
      '  --zone <id>               Zone selector (or CARACAL_ZONE_ID)',
      '  --status active|revoked|expired  Filter by session status',
      '  --subject <id>            Filter by subject (user) ID',
      '  --limit N                 Maximum number of rows to return',
      '  --json                    Emit raw JSON',
      '  --help, -h                Show this help',
      '',
    ],
  )
}
