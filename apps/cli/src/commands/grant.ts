// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal grant …` admin subcommands.

import type { CliConfig } from '../config.ts'
import { printSuccess } from '../style.ts'
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
  showHelp,
  unknownVerb,
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
        if (!id) return usage('grant revoke <id> [--zone …] [--dry-run]')
        if (flagBool(flags, 'dry-run')) {
          const g = await client.grants.get(zoneId, id)
          printSuccess(`[dry-run] would revoke grant ${id} (app=${g.application_id} user=${g.user_id} resource=${g.resource_id} scopes=${(g.scopes ?? []).join(',')})`)
          return
        }
        await client.grants.revoke(zoneId, id)
        printSuccess(`revoked ${id}`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
        return help()
      default:
        return unknownVerb('grant', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): never {
  return showHelp(
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
      '    --dry-run               Show what would be revoked without doing it',
      '',
      'Flags:',
      '  --zone <id>             Zone selector (or CARACAL_ZONE_ID)',
      '  --json                  Emit raw JSON',
      '  --help, -h              Show this help',
      '',
    ],
  )
}
