// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects just-in-time credentials into child process env.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverRepoRoot } from '@caracalai/core'
import { buildRunEnv, runExec } from '@caracalai/engine'
import type { RuntimeConfig } from '../config.ts'
import { printError } from '../style.ts'

const RUN_HELP = `Usage: caracal run [--] <command> [args...]

Launch <command> with short-lived Caracal credentials injected as environment variables.

caracal run is the data-plane launcher. It exchanges the configured application
identity for scoped credentials (15-minute maximum TTL), injects them into the
environment variables named in the credential manifest, spawns the command with a
scrubbed environment (PATH-like allowlist plus injected credentials, no other
variables), forwards SIGINT/SIGTERM/SIGHUP/SIGQUIT, and exits with the command's
exit code.

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
  Identity comes from a caracal.toml runtime profile or environment variables:
  zone ID, application ID, client secret, and credential entries mapping env names
  to resources. Create the objects in the Caracal web console, store the one-time
  client secret in an owner-only file, and grant access through an active policy.
  Use credential_type=provider_token for provider-native key injection and
  credential_type=caracal_mandate for mandate-aware code. See the Configure
  Workloads documentation for profile paths and cloud/custom deployments.
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

export async function runCommand(argv: string[], cfg?: RuntimeConfig): Promise<void> {
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
    printError('runtime config is required to run a command')
    process.exit(1)
  }

  let env: Record<string, string>
  try {
    assertNoWorkspaceOperatorSecrets()
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

  const handle = runExec({ argv: commandArgs, env })
  const code = await handle.exitCode
  process.exit(code)
}
