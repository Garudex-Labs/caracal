// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration types.

// DefaultMaxHopCount caps delegation chain depth when verifier callers leave
// JwtConfig.maxHopCount unset. Matches the coordinator's MAX_DEPTH so a token
// that would have been blocked when a Session starts cannot pass a permissive resource
// server.
export const DEFAULT_MAX_HOP_COUNT = 10
export const MANDATE_USE_SESSION = 'session'
export const MANDATE_USE_RESOURCE = 'resource'
export const SUBJECT_TYPE_USER = 'user'
export const SUBJECT_TYPE_APPLICATION = 'application'

export interface JwtConfig {
  issuer: string
  audience: string
  // The zone is a mandatory trust anchor. It fixes which zone's signing keyset
  // verifies the token, so key selection can never be steered by the unverified
  // zone_id claim. A verifier must know the single zone it serves.
  zoneId: string
  requiredScopes?: string[]
  requiredTargets?: string[]
  requiredUse?: string
  requireSession?: boolean
  requireDelegation?: boolean
  requireChainContains?: string[]
  maxHopCount?: number
}

export interface ChainHop {
  applicationId: string
  sessionId?: string
  delegationId?: string
}

export interface Claims {
  sub: string
  zoneId: string
  clientId: string
  authorityRecordId: string
  rootAuthorityRecordId: string
  use: string
  subType: string
  jti: string
  issuedAt: number
  expiresAt: number
  scope: string
  targetResources?: string[]
  sessionId?: string
  delegationId?: string
  sourceSessionId?: string
  targetSessionId?: string
  delegationPath?: string[]
  delegationChain?: ChainHop[]
  graphEpoch?: number
  hopCount?: number
}
