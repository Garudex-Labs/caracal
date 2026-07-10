# packages/verify/go

## Scope
- Covers the Go verification engine module under `packages/verify/go/`.

## Architecture Design
- The module authenticates Caracal JWTs with `packages/identity/go` and checks revocation through `packages/revocation/go`.

## Required
- Must use Go 1.26 and expose a framework-neutral `Authenticate` result.
- Must require caller-provided revocation behavior for session checks.
- Must keep auth errors typed for adapter mapping.

## Forbidden
- Must not depend on net/http middleware, Express, FastMCP, Redis, or service internals.
- Must not perform storage lookups except through the revocation interface.
- Must not log plaintext tokens.

## Validation
- Validate with `go test ./packages/verify/go/...`.

