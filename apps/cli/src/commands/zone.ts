// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal zone …` admin subcommands.

import {
  zoneList,
  zoneGet,
  zoneCreate,
  zonePatch,
  zoneDelete,
} from '@caracalai/cli-core'
import type { CliConfig } from '../config.ts'
import { printSuccess } from '../style.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  showHelp,
  unknownVerb,
  usage,
} from './shared.ts'

export async function zoneCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const { client } = buildAdminClient(cfg)
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const rows = await zoneList({ client })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'name', 'slug', 'org_id', 'dcr_enabled', 'pkce_required'])
      }
      case 'get': {
        const id = positional[0]
        if (!id) return usage('zone get <id>')
        return printJSON(await zoneGet({ client, id }))
      }
      case 'create': {
        const name = flagString(flags, 'name')
        if (!name) return usage('zone create --name <name> [--slug …] [--org <id>] [--dcr] [--no-pkce]')
        return printJSON(await zoneCreate({
          client,
          input: {
            name,
            slug: flagString(flags, 'slug'),
            org_id: flagString(flags, 'org'),
            dcr_enabled: flagBool(flags, 'dcr') || undefined,
            pkce_required: flagBool(flags, 'no-pkce') ? false : undefined,
            login_flow: flagString(flags, 'login-flow'),
          },
        }))
      }
      case 'patch': {
        const id = positional[0]
        if (!id) return usage('zone patch <id> [--name …] [--slug …] [--dcr=true|false] …')
        return printJSON(await zonePatch({
          client,
          id,
          input: {
            name: flagString(flags, 'name'),
            slug: flagString(flags, 'slug'),
            org_id: flagString(flags, 'org'),
            dcr_enabled: flags['dcr'] === undefined ? undefined : flagBool(flags, 'dcr'),
            pkce_required: flags['pkce'] === undefined ? undefined : flagBool(flags, 'pkce'),
            login_flow: flagString(flags, 'login-flow'),
          },
        }))
      }
      case 'delete': {
        const id = positional[0]
        if (!id) return usage('zone delete <id>')
        await zoneDelete({ client, id })
        printSuccess(`deleted ${id}`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
        return help()
      default:
        return unknownVerb('zone', verb, help)
    }
  } catch (err) {
    fail(err)
  }
}

function help(): never {
  return showHelp(
    [
      'Usage: caracal zone <verb> [options]',
      '',
      'Verbs:',
      '  list                    List all zones',
      '  get <id>                Fetch a zone by ID as JSON',
      '  create                  Create a new zone',
      '    --name <n>              Zone display name (required)',
      '    --slug <s>              URL-safe slug (auto-derived from name if omitted)',
      '    --org <id>              Organization ID',
      '    --dcr                   Enable dynamic client registration',
      '    --no-pkce               Disable PKCE (PKCE is required by default)',
      '    --login-flow <flow>     Login flow type (default: standard)',
      '  patch <id>              Update fields on a zone (only supplied flags change)',
      '    --name, --slug, --org, --login-flow',
      '    --dcr=true|false, --pkce=true|false',
      '  delete <id>             Permanently delete a zone and all its resources',
      '',
      'Flags:',
      '  --json                  Emit raw JSON instead of a table',
      '  --help, -h              Show this help',
      '',
    ],
  )
}
