// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal app …` admin subcommands.

import type { CliConfig } from '../config.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagInt,
  flagList,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
  unknownVerb,
  usage,
} from './shared.ts'

export async function appCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.applications.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'name', 'registration_method', 'credential_type', 'consent', 'created_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('app get <id> [--zone …]')
        return printJSON(await client.applications.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const name = flagString(flags, 'name')
        if (!name) return usage('app create --name <n> [--method managed|dcr] [--credential-type …] [--client-secret …] [--traits a,b] [--consent]')
        return printJSON(await client.applications.create(zoneId, {
          name,
          registration_method: (flagString(flags, 'method') as 'managed' | 'dcr' | undefined) ?? 'managed',
          credential_type: flagString(flags, 'credential-type') as 'token' | 'password' | 'public-key' | 'url' | 'public' | undefined,
          client_secret: flagString(flags, 'client-secret'),
          traits: flagList(flags, 'traits'),
          consent: flagBool(flags, 'consent') || undefined,
        }))
      }
      case 'patch': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('app patch <id> [--name …] [--credential-type …] [--client-secret …] [--traits …]')
        return printJSON(await client.applications.patch(zoneId, id, {
          name: flagString(flags, 'name'),
          credential_type: flagString(flags, 'credential-type') as 'token' | 'password' | 'public-key' | 'url' | 'public' | undefined,
          client_secret: flagString(flags, 'client-secret'),
          traits: flagList(flags, 'traits'),
          consent: flags['consent'] === undefined ? undefined : flagBool(flags, 'consent'),
        }))
      }
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('app delete <id> [--zone …]')
        await client.applications.delete(zoneId, id)
        process.stdout.write(`deleted ${id}\n`)
        return
      }
      case 'dcr': {
        const zoneId = requireZone(ctx, flags)
        const name = flagString(flags, 'name')
        if (!name) return usage('app dcr --name <n> [--credential-type …] [--client-secret …] [--traits …] [--expires-in <s>]')
        return printJSON(await client.applications.dcr(zoneId, {
          name,
          credential_type: flagString(flags, 'credential-type') as 'token' | 'password' | 'public-key' | 'url' | 'public' | undefined,
          client_secret: flagString(flags, 'client-secret'),
          traits: flagList(flags, 'traits'),
          expires_in: flagInt(flags, 'expires-in'),
        }))
      }
      case 'help':
      case '--help':
      case '-h':
        return help()
      default:
        return unknownVerb('app', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): void {
  process.stdout.write(
    [
      'Usage: caracal app <verb> [options]',
      '',
      'Verbs:',
      '  list                    List applications in a zone',
      '  get <id>                Fetch an application by ID as JSON',
      '  create                  Register a new application',
      '    --name <n>              Application name (required)',
      '    --method managed|dcr    Registration method (default: managed)',
      '    --credential-type <t>   token | password | public-key | url | public',
      '    --client-secret <s>     Pre-set a client secret',
      '    --traits a,b            Comma-separated trait list',
      '    --consent               Enable consent requirement',
      '  patch <id>              Update an application',
      '    --name, --credential-type, --client-secret, --traits, --consent=true|false',
      '  delete <id>             Permanently delete an application',
      '  dcr                     Dynamic client registration (DCR)',
      '    --name <n>              Application name (required)',
      '    --credential-type <t>   Credential type',
      '    --client-secret <s>     Client secret',
      '    --traits a,b            Trait list',
      '    --expires-in <s>        Token TTL in seconds',
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
