// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal resource …` admin subcommands.

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
} from './shared.ts'

export async function resourceCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.resources.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'identifier', 'name', 'upstream_url', 'scopes', 'credential_provider_id'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('resource get <id> [--zone …]')
        return printJSON(await client.resources.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const identifier = flagString(flags, 'identifier')
        const scopes = flagList(flags, 'scopes')
        if (!identifier || !scopes || scopes.length === 0) {
          return usage('resource create --identifier <id> --scopes a,b [--name …] [--upstream-url …] [--prefix] [--provider …]')
        }
        return printJSON(await client.resources.create(zoneId, {
          identifier,
          scopes,
          name: flagString(flags, 'name'),
          upstream_url: flagString(flags, 'upstream-url'),
          prefix: flagBool(flags, 'prefix') || undefined,
          credential_provider_id: flagString(flags, 'provider'),
        }))
      }
      case 'patch': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('resource patch <id> [--identifier …] [--scopes …] [--upstream-url …] [--name …] [--provider …] [--prefix=true|false]')
        return printJSON(await client.resources.patch(zoneId, id, {
          identifier: flagString(flags, 'identifier'),
          name: flagString(flags, 'name'),
          upstream_url: flagString(flags, 'upstream-url'),
          prefix: flags['prefix'] === undefined ? undefined : flagBool(flags, 'prefix'),
          scopes: flagList(flags, 'scopes'),
          credential_provider_id: flagString(flags, 'provider'),
        }))
      }
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('resource delete <id> [--zone …]')
        await client.resources.delete(zoneId, id)
        process.stdout.write(`deleted ${id}\n`)
        return
      }
      default:
        return usage('resource <list|get|create|patch|delete> [...]')
    }
  } catch (err) {
    fail(err)
  }
}

function usage(line: string): void {
  process.stderr.write(`Usage: caracal ${line}\n`)
  process.exit(1)
}
