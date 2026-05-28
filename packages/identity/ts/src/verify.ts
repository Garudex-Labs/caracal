// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

import { jwtVerify } from 'jose'
import { CaracalError, hasScope } from '@caracalai/core'
import { getKeySet, type JwksCache } from './jwks.js'
import { DEFAULT_MAX_HOP_COUNT, MANDATE_USE_RESOURCE, MANDATE_USE_SESSION, type ChainHop, type Claims, type JwtConfig } from './types.js'

const REQUIRED_CLAIMS = ['exp', 'iat', 'jti', 'sub', 'client_id', 'sid', 'root_sid', 'use', 'sub_type']

export class TokenInvalidError extends CaracalError {
  constructor(message = 'Token validation failed', cause?: unknown) {
    super('invalid_token', message, cause !== undefined ? { cause } : {})
    this.name = 'TokenInvalidError'
  }
}

export class ZoneInvalidError extends CaracalError {
  constructor(message = 'Token zone validation failed') {
    super('zone_invalid', message)
    this.name = 'ZoneInvalidError'
  }
}

export class ScopeInsufficientError extends CaracalError {
  readonly missingScope: string
  constructor(missingScope: string) {
    super('scope_insufficient', `Missing scope: ${missingScope}`, { details: { missingScope } })
    this.name = 'ScopeInsufficientError'
    this.missingScope = missingScope
  }
}

export class AgentIdentityRequiredError extends CaracalError {
  constructor(message = 'Agent identity required') {
    super('agent_identity_required', message)
    this.name = 'AgentIdentityRequiredError'
  }
}

export class DelegationRequiredError extends CaracalError {
  constructor(message = 'Delegation required') {
    super('delegation_required', message)
    this.name = 'DelegationRequiredError'
  }
}

export class ChainMismatchError extends CaracalError {
  readonly missingApplicationId: string
  constructor(missingApplicationId: string) {
    super('chain_mismatch', `Delegation chain missing application: ${missingApplicationId}`, {
      details: { missingApplicationId },
    })
    this.name = 'ChainMismatchError'
    this.missingApplicationId = missingApplicationId
  }
}

export class HopCountExceededError extends CaracalError {
  constructor(message = 'Hop count exceeded') {
    super('hop_count_exceeded', message)
    this.name = 'HopCountExceededError'
  }
}

function requiredString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name]
  if (typeof value !== 'string' || value === '') {
    throw new TokenInvalidError(`Token claim ${name} is required`)
  }
  return value
}

function optionalString(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new TokenInvalidError(`Token claim ${name} must be a string`)
  return value
}

function optionalInteger(payload: Record<string, unknown>, name: string): number | undefined {
  const value = payload[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TokenInvalidError(`Token claim ${name} must be a non-negative integer`)
  }
  return value
}

function requiredInteger(payload: Record<string, unknown>, name: string): number {
  const value = optionalInteger(payload, name)
  if (value === undefined) throw new TokenInvalidError(`Token claim ${name} is required`)
  return value
}

function readStringList(raw: unknown, name: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new TokenInvalidError(`Token claim ${name} must be a string array`)
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || value === '') throw new TokenInvalidError(`Token claim ${name} must be a string array`)
    out.push(value)
  }
  return out
}

function readChain(raw: unknown): ChainHop[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new TokenInvalidError('Token claim delegation_chain must be an array')
  const out: ChainHop[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TokenInvalidError('Token claim delegation_chain must contain objects')
    }
    const r = item as Record<string, unknown>
    const applicationId = requiredString(r, 'application_id')
    const agentSessionId = optionalString(r, 'agent_session_id')
    const delegationEdgeId = optionalString(r, 'delegation_edge_id')
    out.push({ applicationId, agentSessionId, delegationEdgeId })
  }
  return out.length === 0 ? undefined : out
}

export async function verify(token: string, config: JwtConfig & { jwksCache?: JwksCache }): Promise<Claims> {
  let payload
  try {
    const keySet = config.jwksCache ? await config.jwksCache.getKeySet(config.issuer) : await getKeySet(config.issuer)
    ;({ payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['ES256'],
      requiredClaims: REQUIRED_CLAIMS,
    }))
  } catch (err) {
    throw new TokenInvalidError('Token validation failed', err)
  }

  const jti = requiredString(payload, 'jti')
  const sub = requiredString(payload, 'sub')
  const clientId = requiredString(payload, 'client_id')
  const sid = requiredString(payload, 'sid')
  const rootSid = requiredString(payload, 'root_sid')
  const use = requiredString(payload, 'use')
  if (use !== MANDATE_USE_SESSION && use !== MANDATE_USE_RESOURCE) throw new TokenInvalidError('Token use validation failed')
  const subType = requiredString(payload, 'sub_type')
  if (subType !== 'user' && subType !== 'application') throw new TokenInvalidError('Token subject type validation failed')
  const issuedAt = requiredInteger(payload, 'iat')
  const expiresAt = requiredInteger(payload, 'exp')
  const scope = (payload['scope'] as string | undefined) ?? ''
  if (typeof scope !== 'string') throw new TokenInvalidError('Token claim scope must be a string')
  const targetResources = readStringList(payload['target'], 'target')
  const rawZoneId = payload['zone_id']
  if (typeof rawZoneId !== 'string' || rawZoneId === '' || (config.zoneId && rawZoneId !== config.zoneId)) {
    throw new ZoneInvalidError()
  }
  const zoneId = rawZoneId
  if (config.requiredUse && use !== config.requiredUse) throw new TokenInvalidError('Token use validation failed')
  for (const required of config.requiredScopes ?? []) {
    if (!hasScope(scope, required)) {
      throw new ScopeInsufficientError(required)
    }
  }
  for (const target of config.requiredTargets ?? []) {
    if (!targetResources?.includes(target)) {
      throw new TokenInvalidError('Token target resource validation failed')
    }
  }

  const agentSessionId = optionalString(payload, 'agent_session_id')
  const delegationEdgeId = optionalString(payload, 'delegation_edge_id')
  const sourceSessionId = optionalString(payload, 'source_session_id')
  const targetSessionId = optionalString(payload, 'target_session_id')
  const delegationPath = readStringList(payload['delegation_path'], 'delegation_path')
  const delegationChain = readChain(payload['delegation_chain'])
  const graphEpoch = optionalInteger(payload, 'delegation_graph_epoch')
  const hopCount = optionalInteger(payload, 'hop_count')

  if (config.requireAgent && !agentSessionId) {
    throw new AgentIdentityRequiredError()
  }
  if (config.requireDelegation && !delegationEdgeId) {
    throw new DelegationRequiredError()
  }
  const maxHops = config.maxHopCount !== undefined && config.maxHopCount > 0
    ? config.maxHopCount
    : DEFAULT_MAX_HOP_COUNT
  if ((hopCount ?? 0) > maxHops) {
    throw new HopCountExceededError()
  }
  for (const expected of config.requireChainContains ?? []) {
    const present = delegationChain?.some((h) => h.applicationId === expected)
    if (!present) throw new ChainMismatchError(expected)
  }

  return {
    sub,
    zoneId,
    clientId,
    sid,
    rootSid,
    use,
    subType,
    jti,
    issuedAt,
    expiresAt,
    scope,
    targetResources,
    agentSessionId,
    delegationEdgeId,
    sourceSessionId,
    targetSessionId,
    delegationPath,
    delegationChain,
    graphEpoch,
    hopCount,
  }
}

export function verifyChainContains(claims: Claims, applicationId: string): boolean {
  if (claims.delegationChain?.some((h) => h.applicationId === applicationId)) return true
  if (claims.clientId === applicationId) return true
  return false
}
