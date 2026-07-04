// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects just-in-time credentials into child process env.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverRepoRoot } from '@caracalai/core'
import { buildRunEnv, resolveRunConfig, runExec } from '@caracalai/engine'
import type { RuntimeIdentity } from '../config.ts'
import { printError } from '../style.ts'

const RUN_HELP = `Usage: caracal run [--] <command> [args...]

Launch <command> with short-lived Caracal credentials injected as environment variables.

caracal run is the data-plane launcher. It authenticates with the workload id
and secret, fetches the credential bindings authored for that launcher in the
web console, mints each bound provider credential under least-privilege scopes,
injects them into the environment variables named by the bindings, spawns the
command with a scrubbed environment (PATH-like allowlist plus injected
credentials, no other variables), forwards SIGINT/SIGTERM/SIGHUP/SIGQUIT, and
exits with the command's exit code.

It does not manage zones, applications, resources, policies, or providers (use the
web console), does not renew credentials after launch (long-running workloads use a
Caracal SDK, which re-exchanges on demand), and does not supervise or restart the
command.

Use -- to separate Caracal from the command when the command takes its own flags.

Examples:
  caracal run -- node agent.js --model=gpt-4o-mini
  caracal run python tool.py --serve
  caracal run -- printenv OPENAI_API_KEY

Configuration:
  The workload carries only its identity. Set CARACAL_WORKLOAD_ID and provide
  the secret via CARACAL_WORKLOAD_SECRET, CARACAL_WORKLOAD_SECRET_FILE, or the
  owner-only default file under the OS Caracal config directory. Everything
  else (zone, resources, scopes, env names) lives in the launcher's bindings on
  the Launcher page in the web console. Set CARACAL_STS_URL only when STS is
  not the local default.
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
