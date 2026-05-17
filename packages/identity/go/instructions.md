# identity/go

## Scope
- Covers only the `github.com/garudex-labs/caracal/packages/identity/go` Go module under `packages/identity/go/`.

## Required
- Must implement JWT verification, JWKS fetch and cache, scope evaluation, and typed claim shapes only.
- Must depend only on `github.com/golang-jwt/jwt/v5`.

## Forbidden
- Must not import any transport, framework, runtime, storage backend, or `caracalEnterprise/` code.
- Must not reference MCP, FastMCP, net/http, Postgres, or Cloudflare.
