// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration types.

export interface JwtConfig {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
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
  scope: string
  agentSessionId?: string
  delegationEdgeId?: string
  sourceSessionId?: string
  targetSessionId?: string
  delegationPath?: string[]
  delegationChain?: ChainHop[]
  graphEpoch?: number
  hopCount?: number
}
