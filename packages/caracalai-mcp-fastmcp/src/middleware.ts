// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastMCP auth middleware: validates Caracal JWTs in FastMCP server contexts.

import { jwtVerify } from 'jose'
import { getKeySet } from '@caracalai/mcp'
import { hasScope } from '@caracalai/shared'

export interface FastMcpAuthOptions {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
}

export interface FastMcpContext {
  sub: string
  zoneId: string
  scope: string
}

export async function verifyFastMcpToken(
  token: string,
  opts: FastMcpAuthOptions,
): Promise<FastMcpContext> {
  const keySet = await getKeySet(opts.issuer)
  const { payload } = await jwtVerify(token, keySet, {
    issuer: opts.issuer,
    audience: opts.audience,
  })

  const scope = (payload['scope'] as string | undefined) ?? ''
  const zoneId = payload['zone_id']
  if (typeof zoneId !== 'string' || zoneId === '' || (opts.zoneId && zoneId !== opts.zoneId)) {
    throw new Error('Token zone validation failed')
  }
  for (const required of opts.requiredScopes ?? []) {
    if (!hasScope(scope, required)) {
      throw new Error(`Missing required scope: ${required}`)
    }
  }

  return { sub: payload.sub ?? '', zoneId, scope }
}

export function extractBearer(authHeader: string | undefined): string {
  if (!authHeader?.startsWith('Bearer ') || authHeader.length <= 7) {
    throw new Error('Missing bearer token')
  }
  const token = authHeader.slice(7).trim()
  if (!token) throw new Error('Missing bearer token')
  return token
}
