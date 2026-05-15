// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects ambient 60-min tokens into child process env.

import { runExec } from '@caracalai/cli-core'
import { OAuthClient, InteractionRequiredError } from '@caracalai/oauth'
import type { CliConfig, Credential } from '../config.ts'
import { printError, printWarn } from '../style.ts'

const STEP_UP_POLL_MS = 2000
const STEP_UP_TIMEOUT_MS = 300_000
const TOKEN_TTL_SECONDS = 3600

async function waitForChallenge(zoneUrl: string, challengeId: string): Promise<boolean> {
  const deadline = Date.now() + STEP_UP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${zoneUrl}/step-up/${challengeId}`)
      if (res.ok) {
        const data = (await res.json()) as { satisfied: boolean }
        if (data.satisfied) return true
      }
    } catch {
      // Ignore transient fetch failures while polling.
    }
    await new Promise((r) => setTimeout(r, STEP_UP_POLL_MS))
  }
  return false
}

async function exchangeWithStepUp(
  client: OAuthClient,
  cfg: CliConfig,
  resource: string,
): Promise<string> {
  try {
    const token = await client.exchange('', resource, {
      clientSecret: cfg.app_client_secret,
      ttlSeconds: TOKEN_TTL_SECONDS,
    })
    return token.accessToken
  } catch (err) {
    if (!(err instanceof InteractionRequiredError) || !err.challengeId) throw err
    process.stderr.write(
      JSON.stringify({ resource, challenge_id: err.challengeId, reason: 'step_up_required' }) + '\n',
    )
    const satisfied = await waitForChallenge(cfg.zone_url, err.challengeId)
    if (!satisfied) throw new Error('step_up_challenge_timed_out')
    const token = await client.exchange('', resource, {
      clientSecret: cfg.app_client_secret,
      ttlSeconds: TOKEN_TTL_SECONDS,
    })
    return token.accessToken
  }
}

function logFailure(cred: Credential, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  const requestId = err instanceof InteractionRequiredError ? err.challengeId : undefined
  process.stderr.write(JSON.stringify({ resource: cred.resource, reason, requestId }) + '\n')
}

export async function runCommand(argv: string[], cfg: CliConfig): Promise<void> {
  const commandArgs = argv[0] === '--' ? argv.slice(1) : argv
  if (commandArgs.length === 0) {
    printError('Usage: caracal run <cmd...>')
    process.exit(1)
  }

  const client = new OAuthClient(cfg.zone_url, cfg.zone_id, cfg.application_id)
  const env: Record<string, string> = {}

  for (const cred of cfg.credentials ?? []) {
    try {
      env[cred.env] = await exchangeWithStepUp(client, cfg, cred.resource)
    } catch (err) {
      logFailure(cred, err)
      if (!cfg.continue_on_failure) process.exit(1)
    }
  }

  for (const cred of cfg.optional_credentials ?? []) {
    try {
      env[cred.env] = await exchangeWithStepUp(client, cfg, cred.resource)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      printWarn(`optional credential skipped resource=${cred.resource} reason=${reason}`)
    }
  }

  const handle = runExec({ argv: commandArgs, env, forwardSignals: false })
  const code = await handle.exitCode
  process.exit(code)
}
