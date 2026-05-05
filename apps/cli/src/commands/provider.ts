// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal provider …` admin subcommands.

import type { CliConfig } from '../config.ts'
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
} from './shared.ts'

type ProviderKind = 'oauth2' | 'oidc' | 'apikey' | 'workload'

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
      default:
        return usage('provider <list|get|create|patch|delete> [...]')
    }
  } catch (err) {
    fail(err)
  }
}

function usage(line: string): void {
  process.stderr.write(`Usage: caracal ${line}\n`)
  process.exit(1)
}
