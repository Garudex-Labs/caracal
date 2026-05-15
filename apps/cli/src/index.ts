// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal CLI entry point — stack, runtime, and admin subcommands.

import '@caracalai/engine/scrubCwdEnv'
import { parse } from 'smol-toml'
import { readFileSync } from 'fs'
import { resolveCliConfigPath } from '@caracalai/core/cli'
import { runCommand } from './commands/run.ts'
import { credentialReadCommand } from './commands/credential.ts'
import { initCommand } from './commands/init.ts'
import { upCommand, downCommand, statusCommand } from './commands/stack.ts'
import { purgeCommand } from './commands/purge.ts'
import { zoneCommand } from './commands/zone.ts'
import { appCommand } from './commands/app.ts'
import { resourceCommand } from './commands/resource.ts'
import { providerCommand } from './commands/provider.ts'
import { grantCommand } from './commands/grant.ts'
import { policyCommand, policySetCommand } from './commands/policy.ts'
import { sessionCommand } from './commands/session.ts'
import { auditCommand, explainCommand } from './commands/audit.ts'
import { agentCommand, delegationCommand } from './commands/agent.ts'
import { checkMcpGovernance } from './mcp.ts'
import { style, printError } from './style.ts'
import { CARACAL_MODE, CARACAL_VERSION } from './runtime/version.ts'
import type { CliConfig } from './config.ts'

function usage(out: NodeJS.WriteStream = process.stderr): void {
  const H = (s: string) => style.header(s)
  const L = (s: string) => style.label(s)
  out.write(
    [
      `${style.title('Usage:')} caracal <command> [options]`,
      '',
      H('Stack:'),
      `  up                       Build and start the local stack`,
      `  down [-v]                Stop the stack; ${L('-v')} also removes volumes`,
      `  status                   Probe /health on every service`,
      `  init [--force]           Provision the local zone and write caracal.toml`,
      `  purge [targets...]       Centralized cleanup (stack, volumes, logs, config, runtime, secrets, cache, all)`,
      '',
      H('Runtime:'),
      `  run [--] <cmd...>        Run a command with RESOURCE_TOKEN injected into env`,
      `  credential read <res>    Print the resolved credential for a resource`,
      '',
      H('Admin:'),
      '  zone <list|get|create|patch|delete>',
      '  app  <list|get|create|patch|delete|dcr>',
      '  resource <list|get|create|patch|delete>',
      '  provider <list|get|create|patch|delete>',
      '  policy <list|get|create|version|delete>',
      '  policy-set <list|get|create|version|activate|delete>',
      '  grant <list|get|create|revoke>',
      '  session list',
      '',
      H('Observability:'),
      '  audit tail [--decision …] [--request-id …] [--since …] [--limit N]',
      '  explain <request_id>     Show audit row + determining policies + diagnostics',
      '',
      H('Multi-agent (requires CARACAL_COORDINATOR_TOKEN):'),
      '  agent <list|get|tree|suspend|resume|terminate>',
      '  delegation <inbound|outbound|traverse|revoke>',
      '',
      H('Common flags:'),
      `  --zone <id>              Zone selector (default: zone_id from caracal.toml or ${L('$CARACAL_ZONE_ID')})`,
      '  --json                   Emit JSON instead of a table',
      '  --help, -h               Show this help',
      '',
      H('Environment:'),
      `  ${L('CARACAL_ADMIN_TOKEN')}      Bearer token for /v1/* admin routes`,
      `  ${L('CARACAL_API_URL')}          API base (default http://localhost:3000)`,
      `  ${L('CARACAL_COORDINATOR_URL')}  Coordinator base (default http://localhost:4000)`,
      `  ${L('CARACAL_COORDINATOR_TOKEN')} JWT for coordinator routes (scope: agent:lifecycle)`,
      `  ${L('CARACAL_ZONE_ID')}          Default zone id for admin commands`,
      `  ${L('NO_COLOR / FORCE_COLOR')}   Disable / force terminal colors`,
      '',
    ].join('\n'),
  )
}

function loadConfig(required: boolean): CliConfig | undefined {
  const path = resolveCliConfigPath()
  if (!path) {
    if (!required) return undefined
    printError('caracal.toml not found; run `caracal init` to provision the local zone.')
    process.exit(1)
  }
  try {
    return parse(readFileSync(path, 'utf8')) as unknown as CliConfig
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    printError(`failed to parse ${path}: ${reason}`)
    process.exit(1)
  }
}

const argv = process.argv.slice(2)
const cliArgs = argv[0] === '--' ? argv.slice(1) : argv
const [command, ...rest] = cliArgs

if (!command || command === '--help' || command === '-h') {
  usage(process.stdout)
  process.exit(0)
}

if (command === '--version' || command === '-v' || command === 'version') {
  const tag = CARACAL_MODE === 'dev' ? `dev (sha ${process.env.CARACAL_DEV_SHA ?? 'unknown'})` : `runtime`
  process.stdout.write(`caracal ${CARACAL_VERSION} [${tag}]\n`)
  process.exit(0)
}

if (command === 'init') {
  await initCommand(rest)
} else if (command === 'up') {
  await upCommand(rest)
} else if (command === 'down') {
  await downCommand(rest)
} else if (command === 'status') {
  await statusCommand()
} else if (command === 'purge') {
  await purgeCommand(rest)
} else if (command === 'run') {
  const cfg = loadConfig(true)!
  const cmdArgs = rest[0] === '--' ? rest.slice(1) : rest
  if (cmdArgs.length > 0) checkMcpGovernance(cmdArgs, cfg)
  await runCommand(rest, cfg)
} else if (command === 'credential' && rest[0] === 'read') {
  const cfg = loadConfig(true)!
  await credentialReadCommand(rest[1] ?? '', cfg)
} else if (command === 'zone') {
  await zoneCommand(rest, loadConfig(false))
} else if (command === 'app') {
  await appCommand(rest, loadConfig(false))
} else if (command === 'resource') {
  await resourceCommand(rest, loadConfig(false))
} else if (command === 'provider') {
  await providerCommand(rest, loadConfig(false))
} else if (command === 'policy') {
  await policyCommand(rest, loadConfig(false))
} else if (command === 'policy-set') {
  await policySetCommand(rest, loadConfig(false))
} else if (command === 'grant') {
  await grantCommand(rest, loadConfig(false))
} else if (command === 'session') {
  await sessionCommand(rest, loadConfig(false))
} else if (command === 'audit') {
  await auditCommand(rest, loadConfig(false))
} else if (command === 'explain') {
  await explainCommand(rest, loadConfig(false))
} else if (command === 'agent') {
  await agentCommand(rest, loadConfig(false))
} else if (command === 'delegation') {
  await delegationCommand(rest, loadConfig(false))
} else {
  usage()
  process.exit(1)
}
