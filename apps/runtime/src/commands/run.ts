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

Run <command> with just-in-time credentials injected as environment variables.
Caracal exchanges your workload identity for scoped provider credentials or Caracal
mandates with a maximum 15-minute TTL, then launches the command with a scrubbed
environment so only PATH-like variables and injected credentials reach the child.

Use -- to separate Caracal from the command when the command takes its own flags.

Examples:
  caracal run -- node agent.js --model=gpt-4o-mini
  caracal run python tool.py --serve
  caracal run -- printenv OPENAI_API_KEY

Configuration:
  Requires runtime config (zone, application, client secret). Set it up in the Caracal
  Console, then provide CARACAL_ZONE_ID and CARACAL_APPLICATION_ID, or point CARACAL_CONFIG
  at a runtime profile. Local dev/stable stacks auto-detect credential files under the
  OS Caracal config directory. Use deployment docs for custom/cloud paths.
  Use credential_type=provider_token for provider-native key injection and
  credential_type=caracal_mandate for mandate-aware code.
`

function isHelpToken(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h'
}

function assertNoWorkspaceOperatorSecrets(): void {
  if (process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS === 'true') return
  const root = discoverRepoRoot()
  if (!root) return
  const legacy = join(root, 'infra', 'secrets', 'files', 'caracalAdminToken')
  if (!existsSync(legacy)) return
  throw new Error(
    'refusing to run workload while legacy workspace operator secrets are present; remove infra/secrets/files or set CARACAL_RUN_ALLOW_WORKSPACE_SECRETS=true for trusted local development',
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

  const handle = runExec({ argv: commandArgs, env, forwardSignals: false })
  const code = await handle.exitCode
  process.exit(code)
}
