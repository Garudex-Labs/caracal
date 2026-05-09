// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// @caracalai/mcp — MCP server auth middleware with PostgresBackend.

export * from './middleware.js'
export {
  getKeySet,
  hasScope,
  parseScope,
  scopesAllowed,
  verify,
  ScopeInsufficientError,
  TokenInvalidError,
  ZoneInvalidError,
  type Claims,
  type JwtConfig,
} from '@caracalai/identity'
export { InMemoryRevocationStore, type RevocationStore } from '@caracalai/revocation'
