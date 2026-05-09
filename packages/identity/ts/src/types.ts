// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration types.

export interface JwtConfig {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
}

export interface Claims {
  sub: string
  zoneId: string
  sid: string
  scope: string
  agentSessionId?: string
}
