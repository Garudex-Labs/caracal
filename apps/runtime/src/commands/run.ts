// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects ambient 60-min tokens into child process env.

import { buildRunEnv, runExec } from '@caracalai/engine'
import type { CliConfig } from '../config.ts'
import { printError } from '../style.ts'

export async function runCommand(argv: string[], cfg: CliConfig): Promise<void> {
  const commandArgs = argv[0] === '--' ? argv.slice(1) : argv
  if (commandArgs.length === 0) {
    printError('Usage: caracal run <cmd...>')
    process.exit(1)
  }

  let env: Record<string, string>
  try {
    env = await buildRunEnv(cfg, {
      onLine: (line, stream) => {
        const target = stream === 'stderr' ? process.stderr : process.stdout
        target.write(line + '\n')
      },
    })
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const handle = runExec({ argv: commandArgs, env, forwardSignals: false })
  const code = await handle.exitCode
  process.exit(code)
}
