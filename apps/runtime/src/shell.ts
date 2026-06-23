// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal`: thin top-level runtime CLI that owns stack lifecycle commands and optional interface launchers.
//
// Surface invariant: SHELL_COMMANDS in @caracalai/core/commands is the single source of truth for runtime commands and optional interface launchers. buildRegistry enforces a 1:1 mapping with the executors below after unavailable interfaces are filtered out.

import '@caracalai/engine/scrubCwdEnv'
import { installCrashHandlers } from './crash.ts'
import { runCommand } from './commands/run.ts'
import { upCommand, downCommand, statusCommand, upgradeCommand } from './commands/stack.ts'
import { purgeCommand } from './commands/purge.ts'
import { availableInterfaceCommands, consoleDispatch } from './commands/dispatch.ts'
import { webCommand, webInterfaceAvailable } from './commands/web.ts'
import { checkMcpGovernance } from './mcp.ts'
import { CARACAL_MODE, CARACAL_SHA, CARACAL_VERSION } from './runtime/version.gen.ts'
import { SHELL_COMMANDS } from '@caracalai/engine/commands'
import { buildRegistry, type Executor } from './registry.ts'
import { dispatch } from './dispatcher.ts'

installCrashHandlers('caracal')

const executors: Record<string, Executor> = {
  up: (argv) => upCommand([...argv]),
  down: (argv) => downCommand([...argv]),
  status: (argv) => statusCommand([...argv]),
  upgrade: (argv) => upgradeCommand([...argv]),
  purge: (argv) => purgeCommand([...argv]),
  run: (argv, cfg) => {
    const cmdArgs = argv[0] === '--' ? argv.slice(1) : argv
    if (cmdArgs.length > 0 && cfg) checkMcpGovernance(cmdArgs, cfg)
    return runCommand([...argv], cfg)
  },
  console: (argv) => { consoleDispatch([...argv]) },
  web: (argv) => { webCommand([...argv]) },
}

// `web` is a workspace-only launcher: include it only when both the descriptor
// exists in the canonical surface and the workspace packages are present, so the
// registry's descriptor/executor symmetry holds in every build.
const webAvailable = webInterfaceAvailable() && SHELL_COMMANDS.some((command) => command.name === 'web')
const availableCommands = new Set(['up', 'down', 'status', 'upgrade', 'purge', 'run', ...availableInterfaceCommands(), ...(webAvailable ? ['web'] : [])])
const shellCommands = SHELL_COMMANDS.filter((command) => availableCommands.has(command.name))
const shellExecutors = Object.fromEntries(Object.entries(executors).filter(([name]) => availableCommands.has(name)))
const registry = buildRegistry(shellCommands, shellExecutors)

await dispatch(
  {
    binary: 'caracal',
    version: CARACAL_VERSION,
    mode: CARACAL_MODE,
    sha: CARACAL_SHA,
    registry,
    loadConfig: true,
  },
  process.argv.slice(2),
)
