// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TokenCache interface and in-memory default keyed by hashed subject+resource.

import { createHash } from 'node:crypto'
import type { TokenExchangeResponse } from './types.js'

export interface TokenCache {
  get(subjectToken: string, resource: string): TokenExchangeResponse | undefined
  set(subjectToken: string, resource: string, token: TokenExchangeResponse): void
}

export class InMemoryTokenCache implements TokenCache {
  private readonly map = new Map<string, { token: TokenExchangeResponse; expiresAt: number }>()

  get(subjectToken: string, resource: string): TokenExchangeResponse | undefined {
    const key = cacheKey(subjectToken, resource)
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() / 1000 >= entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    return entry.token
  }

  set(subjectToken: string, resource: string, token: TokenExchangeResponse): void {
    this.map.set(cacheKey(subjectToken, resource), {
      token,
      expiresAt: token.issuedAt + token.expiresIn,
    })
  }
}

function cacheKey(subjectToken: string, resource: string): string {
  return createHash('sha256').update(subjectToken).update('\0').update(resource).digest('hex')
}
