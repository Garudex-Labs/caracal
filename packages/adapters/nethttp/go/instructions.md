# packages/adapters/nethttp/go

## Scope
- Covers the Go net/http adapter module under `packages/adapters/nethttp/go/`.

## Architecture Design
- The module adapts `packages/verify/go` `Authenticate` results to `http.Handler` middleware.

## Required
- Must use Go 1.26 and the standard library `net/http`.
- Must map authentication errors to HTTP responses through the verify engine's `HTTPStatus`; never re-derive status codes locally.
- Must keep caller-provided revocation behavior wired through verify-engine authentication.

## Forbidden
- Must not reimplement JWT verification, JWKS fetching, or revocation lookup directly.
- Must not depend on storage backends or non-standard HTTP frameworks.
- Must not pass unauthenticated requests to downstream handlers.

## Validation
- Validate with `go test ./packages/adapters/nethttp/go/...`.

