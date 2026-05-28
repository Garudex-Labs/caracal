// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastMCP token verifier that delegates to @caracalai/transport-mcp.

import { authenticate, extractBearer } from '@caracalai/transport-mcp'
import type { AuthDeps, AuthErrorCode, AuthOverrides, MandateVerifier } from '@caracalai/transport-mcp'
import { CaracalError } from '@caracalai/core'

export type FastMcpAuthOptions = AuthDeps | MandateVerifier

export interface FastMcpContext {
  sub: string
  zoneId: string
  scope: string
}

export class FastMcpAuthError extends CaracalError {
  constructor(code: AuthErrorCode, description: string) {
    super(code, description)
    this.name = 'FastMcpAuthError'
  }
}

export async function verifyFastMcpToken(
  token: string,
  opts: FastMcpAuthOptions,
  route: AuthOverrides = {},
): Promise<FastMcpContext> {
  const result = 'authenticate' in opts && 'defaults' in opts
    ? await opts.authenticate(token, route)
    : await authenticate(token, { ...opts, ...route })
  if (!result.ok) throw new FastMcpAuthError(result.error.code, result.error.description)
  const claims = result.principal
  return { sub: claims.sub, zoneId: claims.zoneId, scope: claims.scope }
}

export { extractBearer }
