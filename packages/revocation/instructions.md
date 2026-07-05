# packages/revocation

## Scope
- Covers per-language revocation packages under `packages/revocation/`.

## Architecture Design
- Revocation packages define storage-neutral lookup interfaces and in-memory defaults.
- Storage-backed implementations live under `packages/backends/`.

## Required
- Must keep each language implementation in its own child directory.
- Must keep the interface minimal enough for transports and connectors to share.
- Must keep in-memory defaults deterministic for tests and local consumers.

## Forbidden
- Must not include Redis, Postgres, framework, or transport adapters.
- Must not verify JWTs or own request authentication.

## Validation
- Validate through the touched child package and revocation tests for that language.

