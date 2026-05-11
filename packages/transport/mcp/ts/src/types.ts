// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transport-neutral types for MCP authentication: principal, error union, result.

import type { Claims } from '@caracalai/identity'

export type Principal = Claims

export type AuthErrorCode =
  | 'missing_token'
  | 'invalid_token'
  | 'invalid_zone'
  | 'insufficient_scope'
  | 'session_revoked'
  | 'agent_required'
  | 'delegation_required'
  | 'chain_mismatch'
  | 'hop_count_exceeded'

export interface AuthError {
  code: AuthErrorCode
  description: string
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; error: AuthError }
