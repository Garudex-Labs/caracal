// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal credential read <resource>`: prints a one-shot 15-min token to stdout.

import { OAuthClient } from '@caracalai/oauth'
import type { CliConfig } from '../config.ts'

export async function credentialReadCommand(resource: string, cfg: CliConfig): Promise<void> {
  if (!resource) {
    process.stderr.write('Usage: caracal credential read <resource>\n')
    process.exit(1)
  }

  const client = new OAuthClient(cfg.zone_url, cfg.zone_id, cfg.application_id)
  try {
    const token = await client.exchange('', resource, { clientSecret: cfg.app_client_secret, ttlSeconds: 900 })
    process.stdout.write(token.accessToken + '\n')
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ resource, reason: desc }) + '\n')
    process.exit(1)
  }
}
