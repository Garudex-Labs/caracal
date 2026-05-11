// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastMCP token verifier that delegates to @caracalai/transport-mcp.

import { authenticate, extractBearer } from '@caracalai/transport-mcp'
import type { AuthErrorCode } from '@caracalai/transport-mcp'
import type { RevocationStore } from '@caracalai/revocation'

export interface FastMcpAuthOptions {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
  revocations: RevocationStore
  requireAgent?: boolean
  requireDelegation?: boolean
  requireChainContains?: string[]
  maxHopCount?: number
}

export interface FastMcpContext {
  sub: string
  zoneId: string
  scope: string
}

export class FastMcpAuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, description: string) {
    super(description)
    this.name = 'FastMcpAuthError'
    this.code = code
  }
}

export async function verifyFastMcpToken(
  token: string,
  opts: FastMcpAuthOptions,
): Promise<FastMcpContext> {
  const result = await authenticate(token, opts)
  if (!result.ok) throw new FastMcpAuthError(result.error.code, result.error.description)
  const claims = result.principal
  return { sub: claims.sub, zoneId: claims.zoneId, scope: claims.scope }
}

export { extractBearer }
