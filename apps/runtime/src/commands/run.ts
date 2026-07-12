// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects just-in-time credentials into child process env.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverRepoRoot } from '@caracalai/server-core'
import { buildRunEnv, resolveRunConfig, runExec } from '@caracalai/engine'
import type { RuntimeIdentity } from '../config.ts'
import { printError } from '../style.ts'

const RUN_HELP = `Usage: caracal run [--] <command> [args...]

Runs <command> with short-lived provider credentials injected as environment
variables, then exits with its status. Credentials are not renewed after launch;
long-running workloads should use a Caracal SDK. Use -- before commands that take
their own flags.

Examples:
  caracal run -- node agent.js --model=gpt-4o-mini
  caracal run python tool.py --serve

Configuration:
  CARACAL_WORKLOAD_ID          Workload identity (required)
  CARACAL_WORKLOAD_SECRET      Workload secret (or _FILE, or the default file)
  CARACAL_STS_URL              STS endpoint (only if not the local default)

Bindings (zone, resources, scopes, env names) live on the Launcher page in the
web console.
`

function isHelpToken(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h'
}

function assertNoWorkspaceOperatorSecrets(): void {
  if (process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS === 'true') return
  const root = discoverRepoRoot()
  if (!root) return
  const adminToken = join(root, 'infra', 'secrets', 'files', 'caracalAdminToken')
  if (!existsSync(adminToken)) return
  throw new Error(
    'refusing to run workload while workspace operator secrets are present; remove infra/secrets/files or set CARACAL_RUN_ALLOW_WORKSPACE_SECRETS=true for trusted local development',
  )
}

export async function runCommand(argv: string[], cfg?: RuntimeIdentity): Promise<void> {
  if (isHelpToken(argv[0])) {
    process.stdout.write(RUN_HELP)
    process.exit(0)
  }
  const commandArgs = argv[0] === '--' ? argv.slice(1) : argv
  if (commandArgs.length === 0) {
    process.stderr.write(RUN_HELP)
    process.exit(1)
  }
  if (!cfg) {
    printError('workload identity is required to run a command')
    process.exit(1)
  }

  let env: Record<string, string>
  try {
    assertNoWorkspaceOperatorSecrets()
    const runConfig = await resolveRunConfig(cfg)
    env = await buildRunEnv(runConfig, {
      onLine: (line, stream) => {
        const target = stream === 'stderr' ? process.stderr : process.stdout
        target.write(line + '\n')
      },
    })
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const handle = runExec({ argv: commandArgs, env })
  const code = await handle.exitCode
  process.exit(code)
}
