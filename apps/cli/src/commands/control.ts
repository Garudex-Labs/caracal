// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal-cli control …` admin subcommands for managing control API credentials.

import {
  controlKeyCreate,
  controlKeyGet,
  controlKeyList,
  controlKeyRevoke,
  controlKeyRotate,
} from '@caracalai/engine'
import type { CliConfig } from '../config.ts'
import { printError, printSuccess } from '../style.ts'
import { controlToggleCommand } from './controlToggle.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
  showHelp,
  unknownVerb,
  usage,
} from './shared.ts'

export async function controlCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  if (process.env.CARACAL_INVOKED_AS === 'caracal cli') {
    printError('Control management is available only from caracal-cli or the TUI Control menu.')
    process.exit(1)
  }
  const [verb, sub, ...rest] = argv
  if (verb === 'mount' || verb === 'enable' || verb === 'disable' || verb === 'unmount' || verb === 'status') {
    return controlToggleCommand(argv, cfg)
  }
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'key': {
        switch (sub) {
          case 'list': {
            const zoneId = requireZone(ctx, flags)
            const rows = await controlKeyList(client, zoneId)
            if (json) return printJSON(rows)
            return printTable(rows, ['id', 'name', 'credential_type', 'traits', 'created_at'])
          }
          case 'get': {
            const zoneId = requireZone(ctx, flags)
            const id = positional[0]
            if (!id) return usage('control key get <id> [--zone …]')
            return printJSON(await controlKeyGet(client, zoneId, id))
          }
          case 'create': {
            const zoneId = requireZone(ctx, flags)
            const name = flagString(flags, 'name')
            if (!name) return usage('control key create --name <n> [--client-secret <s>] [--zone …]')
            const result = await controlKeyCreate(client, zoneId, {
              name,
              clientSecret: flagString(flags, 'client-secret'),
              audience: flagString(flags, 'audience'),
            })
            printJSON({
              id: result.application.id,
              name: result.application.name,
              client_id: result.application.id,
              client_secret: result.clientSecret,
              resource: result.resource.identifier,
              scopes: result.resource.scopes,
              traits: result.application.traits,
              note: 'store client_secret now — it cannot be retrieved later',
            })
            return
          }
          case 'help':
          case '--help':
          case '-h':
          case undefined:
            return help()
          default:
            return unknownVerb('control key', sub, help)
        }
      }
      case 'rotate': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0] ?? (typeof sub === 'string' && !sub.startsWith('--') ? sub : undefined)
        if (!id) return usage('control rotate <id> [--zone …]')
        const result = await controlKeyRotate(client, zoneId, id)
        printJSON({
          id: result.application.id,
          client_secret: result.clientSecret,
          note: 'store client_secret now — it cannot be retrieved later',
        })
        return
      }
      case 'revoke': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0] ?? (typeof sub === 'string' && !sub.startsWith('--') ? sub : undefined)
        if (!id) return usage('control revoke <id> [--zone …]')
        await controlKeyRevoke(client, zoneId, id)
        printSuccess(`revoked control key ${id}`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        return help()
      default:
        return unknownVerb('control', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): never {
  return showHelp(
    [
      'Usage: caracal-cli control <verb> [...]',
      '',
      'Verbs:',
      '  mount                      Prepare Control without exposing the endpoint',
      '  enable                     Start the mounted endpoint for authenticated automation',
      '  disable                    Stop the endpoint but keep runtime for fast re-enable',
      '  unmount                    Remove the Control runtime for long-term idle state',
      '  status                     Show Control enablement, endpoint, and lifecycle status',
      '  key list                   List control API credentials in a zone',
      '  key get <id>               Show one control API credential',
      '  key create --name <n>      Mint a new control API credential',
      '    --client-secret <s>        Use a pre-shared secret instead of generating one',
      '    --audience <aud>           Control token audience resource (default caracal-control)',
      '  rotate <id>                Rotate the client secret for a control API credential',
      '  revoke <id>                Delete a control API credential (invalidates it immediately)',
      '',
      'Flags:',
      '  --zone <id>                Zone selector (or CARACAL_ZONE_ID)',
      '  --json                     Emit raw JSON',
      '  --help, -h                 Show this help',
      '',
    ],
  )
}
