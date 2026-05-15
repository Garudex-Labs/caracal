// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared helpers for cli-core verbs: AdminClient bootstrap, file content reads, token scrubbing.

import { readFileSync } from 'node:fs'
import { AdminClient } from '@caracalai/admin'
import { discoverAdminToken, runtimeEnvFile } from '@caracalai/core'
import {
  DEFAULT_API_URL,
  DEFAULT_COORDINATOR_URL,
  resolveServiceUrl,
} from '@caracalai/core/cli'
import type { CliConfig } from '@caracalai/core/cli'

export interface AdminContext {
  client: AdminClient
  zoneId: string | undefined
}

export function buildAdminClient(cfg?: CliConfig): AdminContext {
  const adminToken = discoverAdminToken()
  if (!adminToken) {
    throw new Error(
      `CARACAL_ADMIN_TOKEN not set; export it or run \`caracal up\` (writes ${runtimeEnvFile()})`,
    )
  }
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const coordinatorToken = process.env.CARACAL_COORDINATOR_TOKEN
  const zoneId = process.env.CARACAL_ZONE_ID ?? cfg?.zone_id
  return {
    client: new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken }),
    zoneId,
  }
}

export function readContent(value: string | undefined): string {
  if (!value) {
    throw new Error('missing content; use --file <path> or --content <inline>')
  }
  if (value.startsWith('@')) {
    return readFileSync(value.slice(1), 'utf8')
  }
  return value
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9._-]+/g,
  /caracal_at_[A-Za-z0-9._-]+/g,
  /caracal_rt_[A-Za-z0-9._-]+/g,
  /Bearer [^\s]+/g,
]

export function scrubTokens(s: string): string {
  let out = s
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '***')
  return out
}
