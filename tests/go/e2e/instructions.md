# tests/go/e2e

## Scope
- Covers Go end-to-end tests that exercise the full Caracal stack (STS, Gateway, Coordinator, Audit) through user-facing flows.

## Required
- Tests must skip via `t.Skip` when their required environment variable (e.g., `CARACAL_STS_URL`) is unset.
- Tests must follow flows the way an external client would (OAuth token exchange, gateway proxy, audit query).
- Tests must clean up any state they create.

## Forbidden
- Must not import internal packages of the services under test.
- Must not bypass auth, signature, or audit paths.
- Must not assume a fixed deployment topology beyond what the env vars provide.
