// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared helpers for engine verbs: AdminClient bootstrap and file content reads.

import { readFileSync } from 'node:fs'
import { AdminClient } from '@caracalai/admin'
import { discoverAdminToken, discoverCoordinatorToken } from '@caracalai/server-core'
import { DEFAULT_API_URL, DEFAULT_COORDINATOR_URL, resolveServiceUrl } from './runtimeConfig.js'

export interface AdminContext {
  client: AdminClient
  zoneId: string | undefined
  apiUrl: string
}

function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

export function adminTokenProvisionCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARACAL_MODE === 'dev' || (!env.CARACAL_MODE && env.CARACAL_REPO_ROOT !== undefined) ? 'pnpm caracal up' : 'caracal up'
}

// Builds an admin client from the discovered deployment credentials. adminToken overrides the
// discovered token, which the Console BFF uses to drive read-only diagnostics under its
// least-privilege read token instead of the deployment admin token; with no override the
// deployment admin token is discovered as before, so the CLI and every other caller are
// unchanged. headers ride on every request the client makes, which the BFF uses to carry the
// signed per-account assertion so the API scopes reads to the operator's own zones.
export function buildAdminClient(opts: { adminToken?: string; headers?: Record<string, string> } = {}): AdminContext {
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const adminToken = opts.adminToken ?? discoverAdminToken(undefined, { preferGenerated: isLocalUrl(apiUrl) })
  if (!adminToken) {
    throw new Error(`Admin token not found; run \`${adminTokenProvisionCommand()}\` to provision local admin credentials.`)
  }
  const coordinatorToken = discoverCoordinatorToken(undefined, { preferGenerated: isLocalUrl(coordinatorUrl) })
  const zoneId = process.env.CARACAL_ZONE_ID
  return {
    client: new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken, headers: opts.headers }),
    zoneId,
    apiUrl,
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
