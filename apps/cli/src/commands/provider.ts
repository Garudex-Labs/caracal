// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal provider …` admin subcommands.

import type { CliConfig } from '../config.ts'
import type { ProviderKind } from '@caracalai/admin'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  readContent,
  requireZone,
  unknownVerb,
  usage,
} from './shared.ts'

function parseConfig(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  const text = readContent(value)
  return JSON.parse(text) as Record<string, unknown>
}

export async function providerCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.providers.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'identifier', 'name', 'kind', 'owner_type', 'client_id'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('provider get <id> [--zone …]')
        return printJSON(await client.providers.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const identifier = flagString(flags, 'identifier')
        if (!identifier) return usage('provider create --identifier <id> [--name …] [--kind oauth2|oidc|apikey|workload] [--owner-type …] [--client-id …] [--config @file.json|<inline json>]')
        return printJSON(await client.providers.create(zoneId, {
          identifier,
          name: flagString(flags, 'name'),
          kind: flagString(flags, 'kind') as ProviderKind | undefined,
          owner_type: flagString(flags, 'owner-type'),
          client_id: flagString(flags, 'client-id'),
          config_json: parseConfig(flagString(flags, 'config')),
        }))
      }
      case 'patch': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('provider patch <id> [--identifier …] [--name …] [--kind …] [--client-id …] [--config …]')
        return printJSON(await client.providers.patch(zoneId, id, {
          identifier: flagString(flags, 'identifier'),
          name: flagString(flags, 'name'),
          kind: flagString(flags, 'kind') as ProviderKind | undefined,
          owner_type: flagString(flags, 'owner-type'),
          client_id: flagString(flags, 'client-id'),
          config_json: parseConfig(flagString(flags, 'config')),
        }))
      }
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('provider delete <id> [--zone …]')
        await client.providers.delete(zoneId, id)
        process.stdout.write(`deleted ${id}\n`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
        return help()
      default:
        return unknownVerb('provider', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): void {
  process.stdout.write(
    [
      'Usage: caracal provider <verb> [options]',
      '',
      'Verbs:',
      '  list                      List identity providers in a zone',
      '  get <id>                  Fetch a provider by ID as JSON',
      '  create                    Register an identity provider',
      '    --identifier <id>         Provider identifier (required)',
      '    --name <n>                Display name',
      '    --kind <k>                oauth2 | oidc | apikey | workload',
      '    --owner-type <t>          Owner type (e.g. user, agent)',
      '    --client-id <id>          OAuth 2.0 client ID',
      '    --config @file.json       Provider config JSON (use @path or inline JSON)',
      '  patch <id>                Update a provider',
      '    --identifier, --name, --kind, --owner-type, --client-id, --config',
      '  delete <id>               Permanently delete a provider',
      '',
      'Flags:',
      '  --zone <id>               Zone selector (or CARACAL_ZONE_ID)',
      '  --json                    Emit raw JSON',
      '  --help, -h                Show this help',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

