// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal agent …` and `caracal delegation …` coordinator subcommands.

import {
  agentList,
  agentGet,
  agentTree,
  agentSuspend,
  agentResume,
  agentTerminate,
  delegationInbound,
  delegationOutbound,
  delegationTraverse,
  delegationRevoke,
  ensureCoordinatorToken,
} from '@caracalai/cli-core'
import type { CliConfig } from '../config.ts'
import { printError, printSuccess } from '../style.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  parseArgs,
  printJSON,
  printTable,
  requireZone,
  showHelp,
  unknownVerb,
  usage,
} from './shared.ts'

function checkCoordinator(): void {
  try {
    ensureCoordinatorToken()
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export async function agentCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    return agentHelp()
  }

  checkCoordinator()
  const ctx = buildAdminClient(cfg)
  const { client } = ctx
  const { positional, flags } = parseArgs(rest)
  const json = flagBool(flags, 'json')

  try {
    switch (verb) {
      case 'list': {
        const zoneId = requireZone(ctx, flags)
        const rows = await agentList({ client, zoneId })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'application_id', 'parent_id', 'status', 'depth', 'spawned_at', 'terminated_at'])
      }
      case 'get': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent get <id> [--zone …]')
        return printJSON(await agentGet({ client, zoneId, id }))
      }
      case 'children':
      case 'tree': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent tree <id> [--zone …]')
        const rows = await agentTree({ client, zoneId, id })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'application_id', 'parent_id', 'status', 'depth', 'spawned_at'])
      }
      case 'suspend': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent suspend <id> [--zone …]')
        return printJSON(await agentSuspend({ client, zoneId, id }))
      }
      case 'resume': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent resume <id> [--zone …]')
        return printJSON(await agentResume({ client, zoneId, id }))
      }
      case 'terminate': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('agent terminate <id> [--zone …]')
        await agentTerminate({ client, zoneId, id })
        printSuccess(`terminated ${id}`)
        return
      }
      default:
        return unknownVerb('agent', verb, agentHelp)
    }
  } catch (err) {
    fail(err)
  }
}

export async function delegationCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    return delegationHelp()
  }

  checkCoordinator()
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
        const rows = await delegationInbound({ client, zoneId, sessionId })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'source_session_id', 'target_session_id', 'resource_id', 'status', 'expires_at'])
      }
      case 'outbound': {
        const zoneId = requireZone(ctx, flags)
        const sessionId = positional[0]
        if (!sessionId) return usage('delegation outbound <session-id> [--zone …]')
        const rows = await delegationOutbound({ client, zoneId, sessionId })
        if (json) return printJSON(rows)
        return printTable(rows, ['id', 'source_session_id', 'target_session_id', 'resource_id', 'status', 'expires_at'])
      }
      case 'traverse': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('delegation traverse <edge-id> [--zone …]')
        const rows = await delegationTraverse({ client, zoneId, id })
        if (json) return printJSON(rows)
        return printTable(rows, ['depth', 'id', 'source_session_id', 'target_session_id'])
      }
      case 'revoke': {
        const zoneId = requireZone(ctx, flags)
        const id = positional[0]
        if (!id) return usage('delegation revoke <edge-id> [--zone …]')
        return printJSON(await delegationRevoke({ client, zoneId, id }))
      }
      default:
        return unknownVerb('delegation', verb, delegationHelp)
    }
  } catch (err) {
    fail(err)
  }
}

function agentHelp(): never {
  return showHelp(
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
    ],
  )
}

function delegationHelp(): never {
  return showHelp(
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
    ],
  )
}
