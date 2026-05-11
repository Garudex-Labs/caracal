// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transport-neutral MCP authentication: bearer verify, revocation check, typed result.

import {
  AgentIdentityRequiredError,
  ChainMismatchError,
  DelegationRequiredError,
  HopCountExceededError,
  ScopeInsufficientError,
  TokenInvalidError,
  ZoneInvalidError,
  verify,
} from '@caracalai/identity'
import type { RevocationStore } from '@caracalai/revocation'
import type { AuthResult } from './types.js'

export interface AuthDeps {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
  requireAgent?: boolean
  requireDelegation?: boolean
  requireChainContains?: string[]
  maxHopCount?: number
  revocations: RevocationStore
}

export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ') || authHeader.length <= 7) return null
  const token = authHeader.slice(7).trim()
  return token === '' ? null : token
}

export async function authenticate(token: string, deps: AuthDeps): Promise<AuthResult> {
  if (!token) {
    return { ok: false, error: { code: 'missing_token', description: 'Missing bearer token' } }
  }

  try {
    const claims = await verify(token, {
      issuer: deps.issuer,
      audience: deps.audience,
      zoneId: deps.zoneId,
      requiredScopes: deps.requiredScopes,
      requireAgent: deps.requireAgent,
      requireDelegation: deps.requireDelegation,
      requireChainContains: deps.requireChainContains,
      maxHopCount: deps.maxHopCount,
    })
    if (claims.sid && (await deps.revocations.isRevoked(claims.sid))) {
      return { ok: false, error: { code: 'session_revoked', description: 'Session revoked' } }
    }
    return { ok: true, principal: claims }
  } catch (err) {
    if (err instanceof ScopeInsufficientError) {
      return { ok: false, error: { code: 'insufficient_scope', description: err.message } }
    }
    if (err instanceof AgentIdentityRequiredError) {
      return { ok: false, error: { code: 'agent_required', description: err.message } }
    }
    if (err instanceof DelegationRequiredError) {
      return { ok: false, error: { code: 'delegation_required', description: err.message } }
    }
    if (err instanceof ChainMismatchError) {
      return { ok: false, error: { code: 'chain_mismatch', description: err.message } }
    }
    if (err instanceof HopCountExceededError) {
      return { ok: false, error: { code: 'hop_count_exceeded', description: err.message } }
    }
    if (err instanceof ZoneInvalidError) {
      return { ok: false, error: { code: 'invalid_zone', description: 'Token zone validation failed' } }
    }
    if (err instanceof TokenInvalidError) {
      return { ok: false, error: { code: 'invalid_token', description: 'Token validation failed' } }
    }
    return { ok: false, error: { code: 'invalid_token', description: 'Token validation failed' } }
  }
}
