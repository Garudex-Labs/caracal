// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal`: thin top-level shell that owns stack lifecycle commands and dispatches cli/tui to their sibling binaries.
//
// Surface invariant: SHELL_COMMANDS in @caracalai/core/commands is the single source of truth for the top-level commands. buildRegistry enforces a 1:1 mapping with the executors below; any drift fails the build.

import '@caracalai/engine/scrubCwdEnv'
import { installCrashHandlers } from './crash.ts'
import { upCommand, downCommand, statusCommand } from './commands/stack.ts'
import { purgeCommand } from './commands/purge.ts'
import { cliDispatch, tuiDispatch } from './commands/dispatch.ts'
import { CARACAL_MODE, CARACAL_SHA, CARACAL_VERSION } from './runtime/version.gen.ts'
import { SHELL_COMMANDS } from '@caracalai/engine/commands'
import { buildRegistry, type Executor } from './registry.ts'
import { dispatch } from './dispatcher.ts'

installCrashHandlers('caracal')

const executors: Record<string, Executor> = {
  up: (argv) => upCommand([...argv]),
  down: (argv) => downCommand([...argv]),
  status: () => statusCommand(),
  purge: (argv) => purgeCommand([...argv]),
  cli: (argv) => { cliDispatch([...argv]) },
  tui: (argv) => { tuiDispatch([...argv]) },
}

const registry = buildRegistry(SHELL_COMMANDS, executors)

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
