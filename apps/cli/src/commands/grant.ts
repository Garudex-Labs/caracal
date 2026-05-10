// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal grant …` admin subcommands.

import type { CliConfig } from '../config.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagList,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
  usage,
} from './shared.ts'

export async function grantCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.grants.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'application_id', 'user_id', 'resource_id', 'scopes', 'status', 'created_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('grant get <id> [--zone …]')
        return printJSON(await client.grants.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const application_id = flagString(flags, 'app')
        const user_id = flagString(flags, 'user')
        const resource_id = flagString(flags, 'resource')
        const scopes = flagList(flags, 'scopes')
        if (!application_id || !user_id || !resource_id || !scopes || scopes.length === 0) {
          return usage('grant create --app <id> --user <id> --resource <id> --scopes a,b')
        }
        return printJSON(await client.grants.create(zoneId, { application_id, user_id, resource_id, scopes }))
      }
      case 'revoke':
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('grant revoke <id> [--zone …]')
        await client.grants.revoke(zoneId, id)
        process.stdout.write(`revoked ${id}\n`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
      default:
        return help()
    }
  } catch (err) {
    fail(err)
  }
}

function help(): void {
  process.stdout.write(
    [
      'Usage: caracal grant <verb> [options]',
      '',
      'Verbs:',
      '  list                    List grants in a zone',
      '  get <id>                Fetch a grant by ID as JSON',
      '  create                  Issue a new grant',
      '    --app <id>              Application ID (required)',
      '    --user <id>             User/subject ID (required)',
      '    --resource <id>         Resource ID (required)',
      '    --scopes a,b            Comma-separated scopes (required)',
      '  revoke <id>             Revoke a grant (alias: delete)',
      '',
      'Flags:',
      '  --zone <id>             Zone selector (or CARACAL_ZONE_ID)',
      '  --json                  Emit raw JSON',
      '  --help, -h              Show this help',
      '',
    ].join('\n'),
  )
  process.exit(0)
}
