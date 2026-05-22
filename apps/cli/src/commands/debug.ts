// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal debug ...` operator workflows for request-level decision tracing.

import type { CliConfig } from '../config.ts'
import type { DecisionTrace } from '@caracalai/admin'
import { printError } from '../style.ts'
import {
  buildAdminClient,
  fail,
  flagBool,
  parseArgs,
  printJSON,
  requireZone,
  showHelp,
  unknownVerb,
} from './shared.ts'
import { printAuthorityFlow } from './audit.ts'

export async function debugCommand(argv: string[], cfg?: CliConfig): Promise<void> {
  const [verb, ...rest] = argv

  try {
    switch (verb) {
      case 'request':
        return debugRequest(rest, cfg)
      case 'help':
      case '--help':
      case '-h':
        return debugHelp()
      default:
        return unknownVerb('debug', verb, debugHelp)
    }
  } catch (err) {
    fail(err)
  }
}

async function debugRequest(argv: string[], cfg?: CliConfig): Promise<void> {
  const ctx = buildAdminClient(cfg)
  const { positional, flags } = parseArgs(argv)
  const requestId = positional[0]
  if (!requestId) {
    printError('Usage: caracal debug request <request_id> [--zone …] [--json] [--flow]')
    process.exit(1)
  }
  const zoneId = requireZone(ctx, flags)
  const trace = await ctx.client.audit.explain(zoneId, requestId)
  if (flagBool(flags, 'json')) return printJSON(trace)
  if (flagBool(flags, 'flow')) return printAuthorityFlow(trace.events)
  printDecisionTrace(trace)
}

function printDecisionTrace(trace: DecisionTrace): void {
  process.stdout.write(`request_id     ${trace.request_id}\n`)
  process.stdout.write(`zone_id        ${trace.zone_id}\n`)
  process.stdout.write(`final_decision ${trace.final_decision}\n`)
  process.stdout.write(`events         ${trace.events.length}\n`)
  process.stdout.write(`denied_events  ${trace.denied.length}\n`)
  if (trace.denied.length > 0) {
    process.stdout.write('failure_reasons:\n')
    for (const event of trace.denied) {
      process.stdout.write(`  ${event.event_type} status=${event.evaluation_status ?? '-'} event=${event.event_id}\n`)
      for (const line of diagnosticLines(event.diagnostics)) {
        process.stdout.write(`    ${line}\n`)
      }
      if (event.diagnostics.length === 0) {
        process.stdout.write('    no structured diagnostics recorded\n')
      }
    }
  }
  const latest = trace.events.at(-1)
  if (latest) {
    process.stdout.write('latest_event:\n')
    process.stdout.write(`  event_type    ${latest.event_type}\n`)
    process.stdout.write(`  decision      ${latest.decision ?? '-'}\n`)
    process.stdout.write(`  status        ${latest.evaluation_status ?? '-'}\n`)
    process.stdout.write(`  policy_set    ${latest.policy_set_id ?? '-'} version=${latest.policy_set_version_id ?? '-'} sha=${latest.manifest_sha ?? '-'}\n`)
  }
}

function diagnosticLines(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [String(item)]
    const data = item as Record<string, unknown>
    const parts = ['code', 'rule', 'reason', 'message']
      .flatMap((key) => typeof data[key] === 'string' && data[key] !== '' ? [`${key}=${data[key]}`] : [])
    return parts.length > 0 ? [parts.join(' ')] : [JSON.stringify(data)]
  })
}

function debugHelp(): never {
  return showHelp(
    [
      'Usage: caracal debug request <request_id> [options]',
      '',
      'Explain one request as an operator decision trace: final decision, denied events, diagnostics, latest event, and optional flow graph.',
      '',
      'Flags:',
      '  --zone <id>                Zone selector (or CARACAL_ZONE_ID)',
      '  --json                     Emit raw DecisionTrace JSON',
      '  --flow                     Render the authority path as Mermaid',
      '  --help, -h                 Show this help',
      '',
      'See also: caracal audit tail --request-id <id>',
      '          caracal explain <request_id> --flow',
      '',
    ],
  )
}