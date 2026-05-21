# tests/go/smoke

## Scope
- Covers Go smoke tests that exercise shared cross-service contracts without external infrastructure.

## Required
- Tests must run with `go test ./tests/go/smoke/...` and require no live services, databases, or network access.
- Tests must exercise wire contracts shared across services (HMAC signatures, schema versions, fixture compatibility).

## Forbidden
- Must not depend on environment variables for setup beyond what `go test` provides.
- Must not start subprocesses, containers, or network listeners.
- Must not duplicate coverage that exists in service-local unit tests.
