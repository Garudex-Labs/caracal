// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal agent …` and `caracal delegation …` coordinator subcommands.

import type { CliConfig } from '../config.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  flagString,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
} from './shared.ts'

function ensureCoordinator(): void {
  if (!process.env.CARACAL_COORDINATOR_TOKEN) {
    process.stderr.write(
      'Error: CARACAL_COORDINATOR_TOKEN required (JWT issued by STS with scope "agent:lifecycle"); set it before invoking agent/delegation commands.\n',
    )
    process.exit(1)
  }
}

export async function agentCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  ensureCoordinator()
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await client.agents.list(zoneId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'application_id', 'parent_id', 'status', 'depth', 'spawned_at', 'terminated_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent get <id> [--zone …]')
        return printJSON(await client.agents.get(zoneId, id))
      }
      case 'children':
      case 'tree': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent tree <id> [--zone …]')
        const rows = await client.agents.children(zoneId, id)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'application_id', 'parent_id', 'status', 'depth', 'spawned_at'])
      }
      case 'suspend': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent suspend <id> [--zone …]')
        return printJSON(await client.agents.suspend(zoneId, id))
      }
      case 'resume': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent resume <id> [--zone …]')
        return printJSON(await client.agents.resume(zoneId, id))
      }
      case 'terminate': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent terminate <id> [--zone …]')
        await client.agents.terminate(zoneId, id)
        process.stdout.write(`terminated ${id}\n`)
        return
      }
      case 'help':
      case '--help':
      case '-h':
      default:
        return agentHelp()
    }
  } catch (err) {
    fail(err)
  }
}

export async function delegationCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  ensureCoordinator()
  const [verb, ...rest] = argv
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'inbound': {
        const zoneId = requireZone(ctx, flags)
        const sessionId = positional[0]
        if (!sessionId) return usage('delegation inbound <session-id> [--zone …]')
        const rows = await client.delegations.inbound(zoneId, sessionId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'source_session_id', 'target_session_id', 'resource_id', 'status', 'expires_at'])
      }
      case 'outbound': {
        const zoneId = requireZone(ctx, flags)
        const sessionId = positional[0]
        if (!sessionId) return usage('delegation outbound <session-id> [--zone …]')
        const rows = await client.delegations.outbound(zoneId, sessionId)
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'source_session_id', 'target_session_id', 'resource_id', 'status', 'expires_at'])
      }
      case 'traverse': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('delegation traverse <edge-id> [--zone …]')
        const rows = await client.delegations.traverse(zoneId, id)
        if (json) return printJSON(rows)
        return printTable(rows, ['depth', 'id', 'source_session_id', 'target_session_id'])
      }
      case 'revoke': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('delegation revoke <edge-id> [--zone …]')
        return printJSON(await client.delegations.revoke(zoneId, id))
      }
      case 'help':
      case '--help':
      case '-h':
      default:
        return delegationHelp()
    }
  } catch (err) {
    fail(err)
  }
}

function agentHelp(): void {
  process.stdout.write(
    [
      'Usage: caracal agent <verb> [options]',
      '',
      'Requires: CARACAL_COORDINATOR_TOKEN (JWT with scope agent:lifecycle)',
      '',
      'Verbs:',
      '  list                    List agent sessions in a zone',
      '  get <id>                Fetch an agent session by ID as JSON',
      '  tree <id>               List direct child sessions of an agent',
      '  suspend <id>            Pause an active agent session',
      '  resume <id>             Resume a suspended agent session',
      '  terminate <id>          Permanently end an agent session',
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

function delegationHelp(): void {
  process.stdout.write(
    [
      'Usage: caracal delegation <verb> [options]',
      '',
      'Requires: CARACAL_COORDINATOR_TOKEN (JWT with scope agent:lifecycle)',
      '',
      'Verbs:',
      '  inbound <session-id>    Show delegation edges arriving at a session',
      '  outbound <session-id>   Show delegation edges originating from a session',
      '  traverse <edge-id>      Walk the full delegation chain for an edge',
      '  revoke <edge-id>        Revoke a delegation edge and affected sessions',
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

function usage(line: string): void {
  process.stderr.write(`Usage: caracal ${line}\n`)
  process.exit(1)
}
