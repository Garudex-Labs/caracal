// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal CLI entry point — stack, runtime, and admin subcommands.

import { parse } from 'smol-toml'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'node:os'
import { join } from 'path'
import { runCommand } from './commands/run.ts'
import { credentialReadCommand } from './commands/credential.ts'
import { initCommand } from './commands/init.ts'
import { upCommand, downCommand, statusCommand } from './commands/stack.ts'
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
import type { CliConfig } from './config.ts'

function usage(out: NodeJS.WriteStream = process.stderr): void {
  out.write(
    [
      'Usage: caracal <command> [options]',
      '',
      'Stack:',
      '  up                       Build and start the local stack',
      '  down [-v]                Stop the stack; -v also removes volumes',
      '  status                   Probe /health on every service',
      '  init [--force]           Provision the local zone and write caracal.toml',
      '',
      'Runtime:',
      '  run [--] <cmd...>        Run a command with RESOURCE_TOKEN injected into env',
      '  credential read <res>    Print the resolved credential for a resource',
      '',
      'Admin:',
      '  zone <list|get|create|patch|delete>',
      '  app  <list|get|create|patch|delete|dcr>',
      '  resource <list|get|create|patch|delete>',
      '  provider <list|get|create|patch|delete>',
      '  policy <list|get|create|version|delete>',
      '  policy-set <list|get|create|version|activate|delete>',
      '  grant <list|get|create|revoke>',
      '  session list',
      '',
      'Observability:',
      '  audit tail [--decision …] [--request-id …] [--since …] [--limit N]',
      '  explain <request_id>     Show audit row + determining policies + diagnostics',
      '',
      'Multi-agent (requires CARACAL_COORDINATOR_TOKEN):',
      '  agent <list|get|tree|suspend|resume|terminate>',
      '  delegation <inbound|outbound|traverse|revoke>',
      '',
      'Common flags:',
      '  --zone <id>              Zone selector (default: zone_id from caracal.toml or $CARACAL_ZONE_ID)',
      '  --json                   Emit JSON instead of a table',
      '  --help, -h               Show this help',
      '',
      'Environment:',
      '  CARACAL_ADMIN_TOKEN      Bearer token for /v1/* admin routes',
      '  CARACAL_API_URL          API base (default http://localhost:3000)',
      '  CARACAL_COORDINATOR_URL  Coordinator base (default http://localhost:4000)',
      '  CARACAL_COORDINATOR_TOKEN JWT for coordinator routes (scope: agent:lifecycle)',
      '  CARACAL_ZONE_ID          Default zone id for admin commands',
      '',
    ].join('\n'),
  )
}

function resolveConfigPath(): string | undefined {
  const candidates: string[] = []
  if (process.env.CARACAL_CONFIG) candidates.push(process.env.CARACAL_CONFIG)
  for (const dir of [process.cwd(), process.env.PWD, process.env.INIT_CWD]) {
    if (dir) candidates.push(join(dir, 'caracal.toml'))
  }
  const xdg = process.env.XDG_CONFIG_HOME
  const xdgBase = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  candidates.push(join(xdgBase, 'caracal', 'caracal.toml'))

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return undefined
}

function loadConfig(required: boolean): CliConfig | undefined {
  const path = resolveConfigPath()
  if (!path) {
    if (!required) return undefined
    process.stderr.write('Error: caracal.toml not found; run `caracal init` to provision the local zone.\n')
    process.exit(1)
  }
  try {
    return parse(readFileSync(path, 'utf8')) as unknown as CliConfig
  } catch {
    if (!required) return undefined
    process.stderr.write(`Error: failed to parse ${path}\n`)
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

if (command === 'init') {
  await initCommand(rest)
} else if (command === 'up') {
  await upCommand(rest)
} else if (command === 'down') {
  await downCommand(rest)
} else if (command === 'status') {
  await statusCommand()
} else if (command === 'run') {
  const cfg = loadConfig(true)!
  const [cmd] = rest
  if (cmd) checkMcpGovernance(cmd, cfg)
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
