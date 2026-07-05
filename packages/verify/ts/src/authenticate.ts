// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Framework-neutral mandate verification: bearer verify, revocation check, typed result.

import {
  AgentIdentityRequiredError,
  ChainMismatchError,
  DelegationRequiredError,
  HopCountExceededError,
  ScopeInsufficientError,
  TokenInvalidError,
  ZoneInvalidError,
  MANDATE_USE_RESOURCE,
  verify,
  warmJwks,
  type JwtConfig,
  type JwksCache,
} from '@caracalai/identity'
import type { RevocationStore } from '@caracalai/revocation'
import type { AuthError, AuthErrorCode, AuthResult, Principal } from './types.js'

export type AuthDeps = JwtConfig & { revocations: RevocationStore; jwksCache?: JwksCache }
export type AuthOverrides = Partial<Omit<AuthDeps, 'issuer' | 'audience' | 'revocations' | 'jwksCache'>>

export interface MandateVerifier {
  readonly defaults: AuthDeps
  authenticate: (token: string, overrides?: AuthOverrides) => Promise<AuthResult>
  authorization: (authHeader: string | undefined, overrides?: AuthOverrides) => Promise<AuthResult>
  require: (overrides: AuthOverrides) => MandateVerifier
  warmup: () => Promise<void>
}

const BEARER_SCHEME = 'bearer'

export function extractBearer(authHeader: string | undefined): string | null {
  if (authHeader === undefined || authHeader.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return null
  const value = authHeader.slice(BEARER_SCHEME.length)
  if (value.length === value.trimStart().length) return null
  const token = value.trim()
  return token === '' ? null : token
}

export function createMandateVerifier(defaults: AuthDeps): MandateVerifier {
  return {
    defaults,
    authenticate(token: string, overrides: AuthOverrides = {}): Promise<AuthResult> {
      return authenticate(token, { ...defaults, ...overrides })
    },
    authorization(authHeader: string | undefined, overrides: AuthOverrides = {}): Promise<AuthResult> {
      const token = extractBearer(authHeader)
      return authenticate(token ?? '', { ...defaults, ...overrides })
    },
    require(overrides: AuthOverrides): MandateVerifier {
      return createMandateVerifier({ ...defaults, ...overrides })
    },
    async warmup(): Promise<void> {
      // JWKS keysets are zone-scoped; without a configured zone the keyset to
      // warm is unknown until the first token arrives.
      if (!defaults.zoneId) return
      if (defaults.jwksCache) {
        await defaults.jwksCache.warm(defaults.issuer, defaults.zoneId)
        return
      }
      await warmJwks(defaults.issuer, defaults.zoneId)
    },
  }
}

export async function authenticate(token: string, deps: AuthDeps): Promise<AuthResult> {
  if (!token) {
    return { ok: false, error: authError('missing_token') }
  }

  try {
    const { revocations, ...jwtConfig } = deps
    const claims = await verify(token, { ...jwtConfig, requiredUse: jwtConfig.requiredUse ?? MANDATE_USE_RESOURCE })
    if (!revocations || typeof revocations.isRevoked !== 'function') {
      return { ok: false, error: authError('invalid_token', 'Revocation store required') }
    }
    const activeError = await checkActiveAuthority(claims, revocations)
    if (activeError) {
      return { ok: false, error: activeError }
    }
    return { ok: true, principal: claims }
  } catch (err) {
    if (err instanceof ScopeInsufficientError) {
      return { ok: false, error: authError('insufficient_scope', err.message) }
    }
    if (err instanceof AgentIdentityRequiredError) {
      return { ok: false, error: authError('agent_required', err.message) }
    }
    if (err instanceof DelegationRequiredError) {
      return { ok: false, error: authError('delegation_required', err.message) }
    }
    if (err instanceof ChainMismatchError) {
      return { ok: false, error: authError('chain_mismatch', err.message) }
    }
    if (err instanceof HopCountExceededError) {
      return { ok: false, error: authError('hop_count_exceeded', err.message) }
    }
    if (err instanceof ZoneInvalidError) {
      return { ok: false, error: authError('invalid_zone') }
    }
    if (err instanceof TokenInvalidError) {
      return { ok: false, error: authError('invalid_token') }
    }
    return { ok: false, error: authError('invalid_token') }
  }
}

export async function checkActiveAuthority(claims: Principal, revocations: RevocationStore, nowMs = Date.now()): Promise<AuthError | null> {
  if (!claims.sid) {
    return authError('invalid_token')
  }
  if (claims.expiresAt * 1000 <= nowMs) {
    return authError('invalid_token', 'Token expired during execution')
  }
  const checks = await Promise.all(revocationAnchors(claims).map((anchor) => revocations.isRevoked(anchor)))
  if (checks.some(Boolean)) return authError('session_revoked')
  const epochError = await graphEpochError(claims, revocations)
  if (epochError) return epochError
  return null
}

function revocationAnchors(claims: Principal): string[] {
  const anchors = [claims.sid, claims.rootSid, claims.agentSessionId, claims.delegationEdgeId].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  return [...new Set(anchors)]
}

async function graphEpochError(claims: Principal, revocations: RevocationStore): Promise<AuthError | null> {
  if (claims.graphEpoch === undefined || !revocations.currentDelegationEpoch) return null
  const currentEpoch = await revocations.currentDelegationEpoch(claims.zoneId)
  return currentEpoch > claims.graphEpoch ? authError('delegation_stale') : null
}

function authError(code: AuthError['code'], description = defaultDescription(code)): AuthError {
  return { code, description, hint: defaultHint(code) }
}

/**
 * Canonical HTTP status for an authentication failure code. This is the single
 * source of truth for every HTTP adapter so the boundary semantics stay
 * identical across frameworks and languages.
 *
 * 401 means the credential itself was not accepted (missing, malformed, wrong
 * zone, revoked, or stale). 403 means the mandate verified but the authority it
 * carries is insufficient for the route (missing scope, wrong principal kind, or
 * an unmet delegation requirement).
 */
export function httpStatusForAuthError(code: AuthErrorCode): number {
  switch (code) {
    case 'insufficient_scope':
    case 'agent_required':
    case 'delegation_required':
    case 'chain_mismatch':
    case 'hop_count_exceeded':
      return 403
    default:
      return 401
  }
}

function defaultDescription(code: AuthError['code']): string {
  switch (code) {
    case 'missing_token':
      return 'Missing bearer token'
    case 'invalid_zone':
      return 'Token zone validation failed'
    case 'insufficient_scope':
      return 'Required scope is missing'
    case 'session_revoked':
      return 'Session revoked'
    case 'delegation_stale':
      return 'Delegation graph changed'
    case 'agent_required':
      return 'Agent identity required'
    case 'delegation_required':
      return 'Delegation required'
    case 'chain_mismatch':
      return 'Delegation chain validation failed'
    case 'hop_count_exceeded':
      return 'Hop count exceeded'
    default:
      return 'Token validation failed'
  }
}

function defaultHint(code: AuthError['code']): string {
  switch (code) {
    case 'missing_token':
      return 'Send Authorization: Bearer <Caracal mandate>.'
    case 'invalid_zone':
      return 'Check the configured zoneId and the mandate zone_id claim.'
    case 'insufficient_scope':
      return 'Request a mandate that includes every required scope for this route.'
    case 'session_revoked':
      return 'Refresh the mandate or start a new authorized session.'
    case 'delegation_stale':
      return 'Refresh the mandate so delegated authority is evaluated against the latest graph.'
    case 'agent_required':
      return 'Use an agent-issued resource mandate for this endpoint.'
    case 'delegation_required':
      return 'Use a mandate produced by a delegated grant flow.'
    case 'chain_mismatch':
      return 'Check requireChainContains and the mandate delegation chain.'
    case 'hop_count_exceeded':
      return 'Reduce delegation depth or raise maxHopCount deliberately.'
    default:
      return 'Check issuer, audience, signature, expiry, token use, scopes, and targets.'
  }
}
