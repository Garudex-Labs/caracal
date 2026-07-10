# services/gateway

## Scope
- Covers the Go MCP reverse proxy service under `services/gateway/`.

## Architecture Design
- The gateway exchanges inbound credentials with STS, loads resource bindings from PostgreSQL, tracks replay/revocation state through Redis, and proxies safe upstream requests.
- It listens on port 8081 and uses `net/http` directly.
- Upstream safety checks are enforced both before request dispatch and at dial time.

## Required
- Must use Go 1.26, `net/http`, and `packages/core/go`.
- Must require STS, database, Redis, and stream HMAC configuration needed by rc and stable.
- Must perform a fresh STS exchange for every proxied request.
- Must strip hop-by-hop headers, `X-Caracal-*` routing headers, and `caracal.*` baggage entries before forwarding.
- Must replace inbound Authorization with the STS-issued bearer token.
- Must enforce request size limits, timeouts, replay checks, and safe upstream dialing.

## Forbidden
- Must not cache STS tokens or upstream responses.
- Must not retry STS exchanges or upstream calls after failure.
- Must not log plaintext bearer tokens.
- Must not forward to private, loopback, link-local, CGNAT, or metadata IPs unless explicitly allowed.

## Validation
- Validate with `go test ./services/gateway/...` when gateway code changes.
