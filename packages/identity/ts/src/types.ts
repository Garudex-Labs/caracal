// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration types.

// DefaultMaxHopCount caps delegation chain depth when verifier callers leave
// JwtConfig.maxHopCount unset. Matches the coordinator's MAX_DEPTH so a token
// that would have been blocked at spawn time cannot pass a permissive resource
// server.
export const DEFAULT_MAX_HOP_COUNT = 10
export const MANDATE_USE_SESSION = 'session'
export const MANDATE_USE_RESOURCE = 'resource'
export const SUBJECT_TYPE_USER = 'user'
export const SUBJECT_TYPE_APPLICATION = 'application'

export interface JwtConfig {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
  requiredTargets?: string[]
  requiredUse?: string
  requireAgent?: boolean
  requireDelegation?: boolean
  requireChainContains?: string[]
  maxHopCount?: number
}

export interface ChainHop {
  applicationId: string
  agentSessionId?: string
  delegationEdgeId?: string
}

export interface Claims {
  sub: string
  zoneId: string
  clientId: string
  sid: string
  rootSid: string
  use: string
  subType: string
  jti: string
  issuedAt: number
  expiresAt: number
  scope: string
  targetResources?: string[]
  agentSessionId?: string
  delegationEdgeId?: string
  sourceSessionId?: string
  targetSessionId?: string
  delegationPath?: string[]
  delegationChain?: ChainHop[]
  graphEpoch?: number
  hopCount?: number
}
