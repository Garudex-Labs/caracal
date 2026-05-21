# tests/go/integration

## Scope
- Covers Go integration tests that exercise a running Caracal service or backing dependency over its public API.

## Required
- Tests must skip via `t.Skip` when their required environment variable (e.g., `CARACAL_AUDIT_URL`, `CARACAL_STS_URL`) is unset.
- Tests must hit only documented public endpoints.
- Tests must clean up any state they create.

## Forbidden
- Must not bake fixed hostnames, ports, or credentials into source.
- Must not assume a specific deployment topology beyond what the env vars provide.
- Must not modify shared databases without resetting state on teardown.
