// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

import { jwtVerify } from 'jose'
import { hasScope } from '@caracalai/core'
import { getKeySet } from './jwks.js'
import type { ChainHop, Claims, JwtConfig } from './types.js'

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

export class AgentIdentityRequiredError extends Error {
  constructor(message = 'Agent identity required') {
    super(message)
    this.name = 'AgentIdentityRequiredError'
  }
}

export class DelegationRequiredError extends Error {
  constructor(message = 'Delegation required') {
    super(message)
    this.name = 'DelegationRequiredError'
  }
}

export class ChainMismatchError extends Error {
  readonly missingApplicationId: string
  constructor(missingApplicationId: string) {
    super(`Delegation chain missing application: ${missingApplicationId}`)
    this.name = 'ChainMismatchError'
    this.missingApplicationId = missingApplicationId
  }
}

export class HopCountExceededError extends Error {
  constructor(message = 'Hop count exceeded') {
    super(message)
    this.name = 'HopCountExceededError'
  }
}

function readChain(raw: unknown): ChainHop[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ChainHop[] = []
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>
      const applicationId = typeof r['app'] === 'string'
        ? r['app']
        : typeof r['application_id'] === 'string' ? r['application_id'] : ''
      if (!applicationId) continue
      out.push({
        applicationId,
        agentSessionId: typeof r['session'] === 'string'
          ? r['session']
          : typeof r['agent_session_id'] === 'string' ? r['agent_session_id'] as string : undefined,
        delegationEdgeId: typeof r['edge'] === 'string'
          ? r['edge']
          : typeof r['delegation_edge_id'] === 'string' ? r['delegation_edge_id'] as string : undefined,
      })
    }
  }
  return out.length === 0 ? undefined : out
}

export async function verify(token: string, config: JwtConfig): Promise<Claims> {
  let payload
  try {
    const keySet = await getKeySet(config.issuer)
    ;({ payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['ES256'],
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
  const clientId = typeof payload['client_id'] === 'string' ? (payload['client_id'] as string) : ''
  const agentSessionId = typeof payload['agent_session_id'] === 'string' ? (payload['agent_session_id'] as string) : undefined
  const delegationEdgeId = typeof payload['delegation_edge_id'] === 'string' ? (payload['delegation_edge_id'] as string) : undefined
  const sourceSessionId = typeof payload['source_session_id'] === 'string' ? (payload['source_session_id'] as string) : undefined
  const targetSessionId = typeof payload['target_session_id'] === 'string' ? (payload['target_session_id'] as string) : undefined
  const delegationPath = Array.isArray(payload['delegation_path'])
    ? (payload['delegation_path'] as unknown[]).filter((v) => typeof v === 'string') as string[]
    : undefined
  const delegationChain = readChain(payload['delegation_chain'])
  const graphEpoch = typeof payload['delegation_graph_epoch'] === 'number'
    ? payload['delegation_graph_epoch'] as number
    : (typeof payload['graph_epoch'] === 'number' ? payload['graph_epoch'] as number : undefined)
  const hopCount = typeof payload['hop_count'] === 'number' ? payload['hop_count'] as number : undefined

  if (config.requireAgent && !agentSessionId) {
    throw new AgentIdentityRequiredError()
  }
  if (config.requireDelegation && !delegationEdgeId) {
    throw new DelegationRequiredError()
  }
  if (config.maxHopCount !== undefined && hopCount !== undefined && hopCount > config.maxHopCount) {
    throw new HopCountExceededError()
  }
  for (const expected of config.requireChainContains ?? []) {
    const present = delegationChain?.some((h) => h.applicationId === expected)
    if (!present) throw new ChainMismatchError(expected)
  }

  return {
    sub: typeof payload.sub === 'string' ? payload.sub : '',
    zoneId,
    clientId,
    sid,
    scope,
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
