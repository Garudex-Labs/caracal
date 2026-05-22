// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal`: thin top-level shell that owns stack lifecycle commands and optional interface launchers.
//
// Surface invariant: SHELL_COMMANDS in @caracalai/core/commands is the single source of truth for runtime commands and optional interface launchers. buildRegistry enforces a 1:1 mapping with the executors below after unavailable interfaces are filtered out.

import '@caracalai/engine/scrubCwdEnv'
import { installCrashHandlers } from './crash.ts'
import { upCommand, downCommand, statusCommand } from './commands/stack.ts'
import { purgeCommand } from './commands/purge.ts'
import { availableInterfaceCommands, cliDispatch, tuiDispatch } from './commands/dispatch.ts'
import { CARACAL_MODE, CARACAL_SHA, CARACAL_VERSION } from './runtime/version.gen.ts'
import { SHELL_COMMANDS } from '@caracalai/engine/commands'
import { buildRegistry, type Executor } from './registry.ts'
import { dispatch } from './dispatcher.ts'

installCrashHandlers('caracal')

const executors: Record<string, Executor> = {
  up: (argv) => upCommand([...argv]),
  down: (argv) => downCommand([...argv]),
  status: (argv) => statusCommand([...argv]),
  purge: (argv) => purgeCommand([...argv]),
  cli: (argv) => { cliDispatch([...argv]) },
  tui: (argv) => { tuiDispatch([...argv]) },
}

const availableCommands = new Set(['up', 'down', 'status', 'purge', ...availableInterfaceCommands()])
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
  },
  process.argv.slice(2),
)
