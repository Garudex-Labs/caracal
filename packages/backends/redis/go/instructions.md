# packages/backends/redis/go

## Scope
- Covers the Go Redis revocation connector module under `packages/backends/redis/go/`.

## Architecture Design
- The module implements `packages/revocation/go.Store` against Redis and consumes revocation stream updates.

## Required
- Must use Go 1.26 and `github.com/redis/go-redis/v9`.
- Must keep Redis client behavior separate from MCP and HTTP middleware.
- Must verify stream signatures when configured.

## Forbidden
- Must not verify JWTs or own request authentication.
- Must not depend on transport, identity, or framework packages unless the public revocation interface requires it.
- Must not log raw token identifiers beyond approved fingerprints or keys.

## Validation
- Validate with `go test ./packages/backends/redis/go/...`.

