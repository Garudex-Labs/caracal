// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal launch <agent>`: runs a supported agent inside a Caracal-governed runtime.

import { agentAdapter, agentNames, launchAgent, readAgentProfile } from '@caracalai/engine'
import { printError } from '../style.ts'

const LAUNCH_HELP = `Usage: caracal launch <agent> [--profile <file>] [--command <path>] [-- <agent args>...]

Runs a supported agent inside a Caracal-governed runtime. Model calls go through
the Gateway, which injects the provider credential, and every tool call is decided
by Caracal before it runs. The agent receives no Caracal or upstream credential.
The agent is stopped when its Session is terminated or revoked.

Agents: ${agentNames().join(', ')}

Options:
  --profile <file>    Launch profile JSON naming the model and tools Resources
                      (default: CARACAL_AGENT_PROFILE)
  --command <path>    Agent executable (default: the agent's command on PATH)

Configuration:
  CARACAL_ZONE_ID, CARACAL_APPLICATION_ID     Application the agent acts for
  CARACAL_APP_CLIENT_SECRET or _FILE          Application client secret
  CARACAL_COORDINATOR_URL, CARACAL_STS_URL,
  CARACAL_GATEWAY_URL                         Only if not the local defaults

Example:
  caracal launch claude-code --profile anton.json -- -p "fix the failing test"
`

function isHelpToken(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h'
}

interface LaunchArgs {
  agent: string
  profile?: string
  command?: string
  agentArgs: string[]
}

function parseArgs(argv: string[]): LaunchArgs {
  const [agent, ...rest] = argv
  if (!agent || agent.startsWith('-')) throw new Error('an agent name is required')
  const parsed: LaunchArgs = { agent, agentArgs: [] }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--') {
      parsed.agentArgs = rest.slice(i + 1)
      break
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (flag !== '--profile' && flag !== '--command') throw new Error(`unknown option '${arg}'; pass agent arguments after --`)
    const value = inline ?? rest[++i]
    if (!value) throw new Error(`${flag} requires a value`)
    if (flag === '--profile') parsed.profile = value
    else parsed.command = value
  }
  return parsed
}

export async function launchCommand(argv: string[]): Promise<void> {
  if (isHelpToken(argv[0])) {
    process.stdout.write(LAUNCH_HELP)
    process.exit(0)
  }
  let code: number
  try {
    const args = parseArgs(argv)
    const profilePath = args.profile ?? process.env.CARACAL_AGENT_PROFILE
    if (!profilePath) throw new Error('a launch profile is required; pass --profile or set CARACAL_AGENT_PROFILE')
    code = await launchAgent({
      adapter: agentAdapter(args.agent),
      profile: readAgentProfile(profilePath),
      args: args.agentArgs,
      env: process.env,
      command: args.command,
      onLine: (line) => process.stderr.write(`${line}\n`),
    })
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  process.exit(code)
}
