// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal`: thin top-level runtime CLI that owns stack lifecycle commands and optional interface launchers.
//
// Surface invariant: SHELL_COMMANDS in @caracalai/engine/commands is the single source of truth for runtime commands and optional interface launchers. buildRegistry enforces a 1:1 mapping with the executors below after unavailable interfaces are filtered out.

import '@caracalai/engine/scrubCwdEnv'
import { installCrashHandlers } from './crash.ts'
import { runCommand } from './commands/run.ts'
import { upCommand, downCommand, statusCommand, upgradeCommand } from './commands/stack.ts'
import { purgeCommand } from './commands/purge.ts'
import { allowlistCommand } from './commands/allowlist.ts'
import { configCommand } from './commands/config.ts'
import { webCommand, webInterfaceAvailable } from './commands/web.ts'
import { CARACAL_MODE, CARACAL_SHA, CARACAL_VERSION } from './runtime/version.gen.ts'
import { SHELL_COMMANDS } from '@caracalai/engine/commands'
import { loadOperatorEnv } from '@caracalai/engine/operatorEnv'
import { buildRegistry, type Executor } from './registry.ts'
import { dispatch } from './dispatcher.ts'

installCrashHandlers('caracal')

// Load the operator env file ($CARACAL_HOME/caracal.env, or CARACAL_ENV_FILE) so run, web,
// and up share one configuration source. Runs after scrubCwdEnv strips untrusted
// working-directory dotenv values, and never overrides variables already in the environment.
loadOperatorEnv()

const executors: Record<string, Executor> = {
  up: (argv) => upCommand([...argv]),
  down: (argv) => downCommand([...argv]),
  status: (argv) => statusCommand([...argv]),
  upgrade: (argv) => upgradeCommand([...argv]),
  purge: (argv) => purgeCommand([...argv]),
  allowlist: (argv) => allowlistCommand([...argv]),
  run: (argv, cfg) => runCommand([...argv], cfg),
  config: (argv) => configCommand([...argv]),
  web: (argv) => {
    void webCommand([...argv])
  },
}

// `web` is a workspace-only launcher: include it only when both the descriptor
// exists in the canonical surface and the workspace packages are present, so the
// registry's descriptor/executor symmetry holds in every build.
const webAvailable = webInterfaceAvailable() && SHELL_COMMANDS.some((command) => command.name === 'web')
const availableCommands = new Set([
  'up',
  'down',
  'status',
  'upgrade',
  'purge',
  'allowlist',
  'run',
  'config',
  ...(webAvailable ? ['web'] : []),
])
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
