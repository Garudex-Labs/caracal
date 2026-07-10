# packages/backends/redis

## Scope
- Covers the Redis-backed revocation store grouping under `packages/backends/redis/`.

## Architecture Design
- Redis backends implement revocation lookup and revocation stream consumption for language-specific revocation interfaces.
- Generic revocation interfaces live under `packages/revocation/`.

## Required
- Must keep Redis-specific behavior inside language subdirectories.
- Must verify signed stream messages when a stream HMAC key is configured.
- Must fail closed on lookup errors unless a caller-facing API explicitly exposes a safe testing mode.

## Forbidden
- Must not perform JWT verification or own request authentication.
- Must not import framework-specific packages.
- Must not store plaintext bearer tokens or claims.

## Validation
- Validate through the touched child package.

