# connectors/redis/go

## Scope
- Covers only the `github.com/garudex-labs/caracal/revocationredis` Go module.

## Required
- Must implement the `github.com/garudex-labs/caracal/revocation.Store` interface.
- Must use Redis only for revocation key lookup and revocation stream consumption.
- Must keep stream-consumer logic independent of MCP, net/http, and identity packages.

## Forbidden
- Must not verify JWTs or own request authentication.
