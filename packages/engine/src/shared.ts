// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared helpers for engine verbs: AdminClient bootstrap and file content reads.

import { readFileSync } from 'node:fs'
import { AdminClient } from '@caracalai/admin'
import { discoverAdminToken, discoverCoordinatorToken } from '@caracalai/core'
import {
  DEFAULT_API_URL,
  DEFAULT_COORDINATOR_URL,
  resolveServiceUrl,
} from './runtimeConfig.js'

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
  return env.CARACAL_MODE === 'dev' || (!env.CARACAL_MODE && env.CARACAL_REPO_ROOT !== undefined)
    ? 'pnpm caracal up'
    : 'caracal up'
}

export function buildAdminClient(): AdminContext {
  const apiUrl = resolveServiceUrl('CARACAL_API_URL', DEFAULT_API_URL)
  const coordinatorUrl = resolveServiceUrl('CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const adminToken = discoverAdminToken(undefined, { preferGenerated: isLocalUrl(apiUrl) })
  if (!adminToken) {
    throw new Error(
      `Admin token not found; run \`${adminTokenProvisionCommand()}\` to provision local admin credentials.`,
    )
  }
  const coordinatorToken = discoverCoordinatorToken(undefined, { preferGenerated: isLocalUrl(coordinatorUrl) })
  const zoneId = process.env.CARACAL_ZONE_ID
  return {
    client: new AdminClient({ apiUrl, coordinatorUrl, adminToken, coordinatorToken }),
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
