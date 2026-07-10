// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastMCP token verifier that delegates to @caracalai/verify.

import { authenticate, extractBearer } from '@caracalai/verify'
import type { AuthDeps, AuthErrorCode, AuthOverrides, MandateVerifier } from '@caracalai/verify'
import { CaracalError } from '@caracalai/core'

export type FastMcpAuthOptions = AuthDeps | MandateVerifier

export interface FastMcpContext {
  sub: string
  zoneId: string
  scope: string
}

export class FastMcpAuthError extends CaracalError {
  readonly hint?: string

  constructor(code: AuthErrorCode, description: string, hint?: string) {
    super(code, description)
    this.name = 'FastMcpAuthError'
    this.hint = hint
  }
}

export async function verifyFastMcpToken(token: string, opts: FastMcpAuthOptions, route: AuthOverrides = {}): Promise<FastMcpContext> {
  const result =
    'authenticate' in opts && 'defaults' in opts ? await opts.authenticate(token, route) : await authenticate(token, { ...opts, ...route })
  if (!result.ok) throw new FastMcpAuthError(result.error.code, result.error.description, result.error.hint)
  const claims = result.principal
  return { sub: claims.sub, zoneId: claims.zoneId, scope: claims.scope }
}

export { extractBearer }
