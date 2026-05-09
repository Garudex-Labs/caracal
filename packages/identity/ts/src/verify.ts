// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

import { jwtVerify } from 'jose'
import { hasScope } from '@caracalai/core'
import { getKeySet } from './jwks.js'
import type { Claims, JwtConfig } from './types.js'

export class TokenInvalidError extends Error {
  constructor(message = 'Token validation failed') {
    super(message)
    this.name = 'TokenInvalidError'
  }
}

export class ZoneInvalidError extends Error {
  constructor(message = 'Token zone validation failed') {
    super(message)
    this.name = 'ZoneInvalidError'
  }
}

export class ScopeInsufficientError extends Error {
  readonly missingScope: string
  constructor(missingScope: string) {
    super(`Missing scope: ${missingScope}`)
    this.name = 'ScopeInsufficientError'
    this.missingScope = missingScope
  }
}

export async function verify(token: string, config: JwtConfig): Promise<Claims> {
  let payload
  try {
    const keySet = await getKeySet(config.issuer)
    ;({ payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
    }))
  } catch {
    throw new TokenInvalidError()
  }

  const scope = (payload['scope'] as string | undefined) ?? ''
  const zoneId = payload['zone_id']
  if (typeof zoneId !== 'string' || zoneId === '' || (config.zoneId && zoneId !== config.zoneId)) {
    throw new ZoneInvalidError()
  }
  for (const required of config.requiredScopes ?? []) {
    if (!hasScope(scope, required)) {
      throw new ScopeInsufficientError(required)
    }
  }

  const sid = typeof payload['sid'] === 'string' ? (payload['sid'] as string) : ''
  const agentSessionId = typeof payload['agent_session_id'] === 'string' ? (payload['agent_session_id'] as string) : undefined
  return { sub: payload.sub ?? '', zoneId, sid, scope, agentSessionId }
}
