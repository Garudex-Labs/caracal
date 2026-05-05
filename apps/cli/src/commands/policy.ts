// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal policy …` and `caracal policy-set …` admin subcommands.

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
  readContent,
  requireZone,
} from './shared.ts'

export async function policyCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.policies.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'name', 'description', 'owner_type', 'created_by', 'created_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('policy get <id> [--zone …]')
        return printJSON(await client.policies.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const name = flagString(flags, 'name')
        const file = flagString(flags, 'file')
        const inline = flagString(flags, 'content')
        if (!name || (!file && !inline)) {
          return usage('policy create --name <n> --file <path>|--content <rego> [--description …] [--owner-type …]')
        }
        const content = readContent(file ? `@${file}` : inline)
        return printJSON(await client.policies.create(zoneId, {
          name,
          content,
          description: flagString(flags, 'description'),
          owner_type: flagString(flags, 'owner-type'),
        }))
      }
      case 'version': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        const file = flagString(flags, 'file')
        const inline = flagString(flags, 'content')
        if (!id || (!file && !inline)) {
          return usage('policy version <id> --file <path>|--content <rego>')
        }
        const content = readContent(file ? `@${file}` : inline)
        return printJSON(await client.policies.addVersion(zoneId, id, content, flagString(flags, 'schema-version')))
      }
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('policy delete <id> [--zone …]')
        await client.policies.delete(zoneId, id)
        process.stdout.write(`archived ${id}\n`)
        return
      }
      default:
        return usage('policy <list|get|create|version|delete> [...]')
    }
  } catch (err) {
    fail(err)
  }
}

export async function policySetCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.policySets.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'name', 'active_version_id', 'description', 'created_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('policy-set get <id> [--zone …]')
        return printJSON(await client.policySets.get(zoneId, id))
      }
      case 'create': {
        const zoneId = requireZone(ctx, flags)
        const name = flagString(flags, 'name')
        if (!name) return usage('policy-set create --name <n> [--description …]')
        return printJSON(await client.policySets.create(zoneId, name, flagString(flags, 'description')))
      }
      case 'version': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        const versions = flagList(flags, 'policy-versions')
        if (!id || !versions || versions.length === 0) {
          return usage('policy-set version <id> --policy-versions vid1,vid2,…')
        }
        const manifest = versions.map((policy_version_id) => ({ policy_version_id }))
        return printJSON(await client.policySets.addVersion(zoneId, id, manifest))
      }
      case 'activate': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        const versionId = flagString(flags, 'version')
        if (!id || !versionId) {
          return usage('policy-set activate <id> --version <version-id> [--shadow <version-id>]')
        }
        return printJSON(await client.policySets.activate(zoneId, id, versionId, flagString(flags, 'shadow')))
      }
      case 'delete': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('policy-set delete <id> [--zone …]')
        await client.policySets.delete(zoneId, id)
        process.stdout.write(`archived ${id}\n`)
        return
      }
      default:
        return usage('policy-set <list|get|create|version|activate|delete> [...]')
    }
  } catch (err) {
    fail(err)
  }
}

function usage(line: string): void {
  process.stderr.write(`Usage: caracal ${line}\n`)
  process.exit(1)
}
