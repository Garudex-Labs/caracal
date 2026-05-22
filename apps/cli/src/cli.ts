// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal-cli`: administrative, runtime, and observability commands for the Caracal control plane, dispatched through a strict whitelist registry.

import '@caracalai/engine/scrubCwdEnv'
import { installCrashHandlers } from './crash.ts'
import { runCommand } from './commands/run.ts'
import { credentialCommand } from './commands/credential.ts'
import { zoneCommand } from './commands/zone.ts'
import { appCommand } from './commands/app.ts'
import { resourceCommand } from './commands/resource.ts'
import { providerCommand } from './commands/provider.ts'
import { grantCommand } from './commands/grant.ts'
import { policyCommand, policySetCommand } from './commands/policy.ts'
import { sessionCommand } from './commands/session.ts'
import { auditCommand, explainCommand } from './commands/audit.ts'
import { agentCommand, delegationCommand } from './commands/agent.ts'
import { completionCommand } from './commands/completion.ts'
import { controlCommand } from './commands/control.ts'
import { doctorCommand } from './commands/doctor.ts'
import { manifestCommand } from './commands/manifest.ts'
import { protectCommand } from './commands/protect.ts'
import { checkMcpGovernance } from './mcp.ts'
import { CARACAL_MODE, CARACAL_SHA, CARACAL_VERSION } from './runtime/version.gen.ts'
import { CLI_COMMANDS } from '@caracalai/engine/commands'
import { buildRegistry, type Executor } from './registry.ts'
import { dispatch, loadCliConfig, type DispatchOptions } from './dispatcher.ts'
import { startRepl } from './repl.ts'

const executors: Record<string, Executor> = {
  run: (argv, cfg) => {
    const cmdArgs = argv[0] === '--' ? argv.slice(1) : argv
    if (cmdArgs.length > 0) checkMcpGovernance(cmdArgs, cfg!)
    return runCommand([...argv], cfg!)
  },
  credential: (argv, cfg) => credentialCommand([...argv], cfg),
  zone: (argv, cfg) => zoneCommand([...argv], cfg),
  app: (argv, cfg) => appCommand([...argv], cfg),
  resource: (argv, cfg) => resourceCommand([...argv], cfg),
  provider: (argv, cfg) => providerCommand([...argv], cfg),
  policy: (argv, cfg) => policyCommand([...argv], cfg),
  'policy-set': (argv, cfg) => policySetCommand([...argv], cfg),
  grant: (argv, cfg) => grantCommand([...argv], cfg),
  session: (argv, cfg) => sessionCommand([...argv], cfg),
  audit: (argv, cfg) => auditCommand([...argv], cfg),
  explain: (argv, cfg) => explainCommand([...argv], cfg),
  agent: (argv, cfg) => agentCommand([...argv], cfg),
  delegation: (argv, cfg) => delegationCommand([...argv], cfg),
  control: (argv, cfg) => controlCommand([...argv], cfg),
  doctor: (argv, cfg) => doctorCommand([...argv], cfg),
  manifest: (argv, cfg) => manifestCommand([...argv], cfg),
  protect: (argv, cfg) => protectCommand([...argv], cfg),
  completion: (argv) => completionCommand([...argv]),
}

const registry = buildRegistry(CLI_COMMANDS, executors)

installCrashHandlers('caracal-cli')

const dispatchOptions: DispatchOptions = {
  binary: process.env.CARACAL_INVOKED_AS ?? 'caracal-cli',
  version: CARACAL_VERSION,
  mode: CARACAL_MODE,
  sha: CARACAL_SHA,
  registry,
  loadConfig: true,
}

const args = process.argv.slice(2)
if (args.length === 0 && process.stdin.isTTY) {
  const cfg = loadCliConfig(false)
  await startRepl({ dispatchOptions, cfg })
} else {
  await dispatch(dispatchOptions, args)
}
