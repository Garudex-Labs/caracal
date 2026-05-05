// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal run <cmd...>`: injects ambient 60-min tokens into child process env.

import { spawn } from 'node:child_process'
import { OAuthClient, InteractionRequiredError } from '@caracalai/oauth'
import type { CliConfig } from '../config.ts'

const STEP_UP_POLL_MS = 2000
const STEP_UP_TIMEOUT_MS = 300_000

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
      // network hiccup — keep polling
    }
    await new Promise((r) => setTimeout(r, STEP_UP_POLL_MS))
  }
  return false
}

async function exchangeWithStepUp(
  exchangeFn: (resource: string) => Promise<{ accessToken: string }>,
  resource: string,
  zoneUrl: string,
  clientId: string,
  clientSecret: string,
  env: Record<string, string>,
  envKey: string,
): Promise<void> {
  let challengeId: string | undefined
  try {
    const token = await exchangeFn(resource)
    env[envKey] = token.accessToken
    return
  } catch (err) {
    if (err instanceof InteractionRequiredError && err.challengeId) {
      challengeId = err.challengeId
    } else {
      throw err
    }
  }

  process.stderr.write(
    JSON.stringify({ resource, challenge_id: challengeId, reason: 'step_up_required' }) + '\n',
  )

  const satisfied = await waitForChallenge(zoneUrl, challengeId!)
  if (!satisfied) throw new Error('step_up_challenge_timed_out')

  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: clientId,
    client_secret: clientSecret,
    subject_token: '',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    resource,
    challenge_response: challengeId!,
  })
  const res = await fetch(`${zoneUrl}/oauth/2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) {
    const msg = await res.text()
    throw new Error(`step_up_retry_failed: ${msg}`)
  }
  const data = (await res.json()) as { access_token: string }
  env[envKey] = data.access_token
}

export async function runCommand(argv: string[], cfg: CliConfig): Promise<void> {
  const commandArgs = argv[0] === '--' ? argv.slice(1) : argv
  if (commandArgs.length === 0) {
    process.stderr.write('Usage: caracal run <cmd...>\n')
    process.exit(1)
  }

  const client = new OAuthClient(cfg.zone_url, cfg.app_client_id)
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }

  for (const cred of cfg.credentials ?? []) {
    try {
      await exchangeWithStepUp(
        (r) => client.exchange('', r, { clientSecret: cfg.app_client_secret, ttlSeconds: 3600 }),
        cred.resource,
        cfg.zone_url,
        cfg.app_client_id,
        cfg.app_client_secret,
        env,
        cred.env,
      )
    } catch (err) {
      if (!cfg.continue_on_failure) {
        const desc = err instanceof Error ? err.message : String(err)
        const requestId = err instanceof InteractionRequiredError ? err.challengeId : undefined
        process.stderr.write(
          JSON.stringify({ resource: cred.resource, reason: desc, requestId }) + '\n',
        )
        process.exit(1)
      }
    }
  }

  for (const cred of cfg.optional_credentials ?? []) {
    try {
      await exchangeWithStepUp(
        (r) => client.exchange('', r, { clientSecret: cfg.app_client_secret, ttlSeconds: 3600 }),
        cred.resource,
        cfg.zone_url,
        cfg.app_client_id,
        cfg.app_client_secret,
        env,
        cred.env,
      )
    } catch (err) {
      const desc = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `warn: optional credential skipped resource=${cred.resource} reason=${desc}\n`,
      )
    }
  }

  const [cmd, ...args] = commandArgs
  const proc = spawn(cmd!, args, { env, stdio: 'inherit' })

  const code: number = await new Promise((resolve) => {
    proc.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)))
    proc.on('error', () => resolve(1))
  })
  for (const key of Object.keys(env)) {
    if (!(key in process.env)) delete env[key]
  }
  process.exit(code)
}
