// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal audit …` and `caracal explain <request_id>` debuggability commands.

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

export async function auditCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'tail':
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.audit.list(zoneId, {
          since: flagString(flags, 'since'),
          until: flagString(flags, 'until'),
          request_id: flagString(flags, 'request-id'),
          decision: flagString(flags, 'decision') as 'allow' | 'deny' | 'partial' | undefined,
          event_type: flagString(flags, 'event-type'),
          limit: flagInt(flags, 'limit'),
        })
        if (json) return printJSON(rows)
        return printTable(rows, ['occurred_at', 'event_type', 'decision', 'evaluation_status', 'request_id', 'id'])
      }
      default:
        process.stderr.write('Usage: caracal audit tail [--zone …] [--since iso8601] [--until iso8601] [--request-id …] [--decision allow|deny|partial] [--event-type …] [--limit N]\n')
        process.exit(1)
    }
  } catch (err) {
    fail(err)
  }
}

export async function explainCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(argv)
  const requestId = positional[0]
  if (!requestId) {
    process.stderr.write('Usage: caracal explain <request_id> [--zone …] [--json]\n')
    process.exit(1)
  }
  const zoneId = requireZone(ctx, flags)
  const json = flagBool(flags, 'json')

  try {
    const rows = await client.audit.byRequest(zoneId, requestId)
    if (json) return printJSON(rows)
    for (const row of rows) {
      process.stdout.write(`event       ${row.event_type}  decision=${row.decision ?? '-'}  status=${row.evaluation_status ?? '-'}\n`)
      process.stdout.write(`occurred_at ${row.occurred_at}\n`)
      process.stdout.write(`request_id  ${row.request_id ?? '-'}\n`)
      process.stdout.write(`policy_set  ${row.policy_set_id ?? '-'} version=${row.policy_set_version_id ?? '-'} sha=${row.manifest_sha ?? '-'}\n`)
      if (row.determining_policies_json && row.determining_policies_json.length > 0) {
        process.stdout.write('determining_policies:\n')
        process.stdout.write(JSON.stringify(row.determining_policies_json, null, 2) + '\n')
      }
      if (row.diagnostics_json && row.diagnostics_json.length > 0) {
        process.stdout.write('diagnostics:\n')
        process.stdout.write(JSON.stringify(row.diagnostics_json, null, 2) + '\n')
      }
      if (row.metadata_json) {
        process.stdout.write('metadata:\n')
        process.stdout.write(JSON.stringify(row.metadata_json, null, 2) + '\n')
      }
      process.stdout.write('\n')
    }
  } catch (err) {
    fail(err)
  }
}
