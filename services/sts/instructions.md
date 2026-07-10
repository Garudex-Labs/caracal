# services/sts

## Scope
- Covers the Go security token service under `services/sts/`.

## Architecture Design
- STS performs OAuth 2.0 token exchange, policy evaluation, signing-key access, revocation/replay handling, and audit emission.
- It listens on port 8080 and exposes JWKS for Caracal-issued ES256 tokens.
- PostgreSQL owns policy, grants, keys, Authority records, Sessions, and approval state; Redis carries audit and invalidation streams.

## Required
- Must use Go 1.26, OPA for Rego evaluation, and `packages/core/go`.
- Must sign issued JWTs with ES256 using decrypted zone signing keys.
- Must deny partial policy evaluation results.
- Must verify caller-asserted Session IDs against stored application ownership before issuing tokens.
- Must emit audit events without blocking token exchange on downstream consumer availability.
- Must enforce runtime-safe configuration through core config helpers.

## Forbidden
- Must not embed Cedar or another policy engine.
- Must not store plaintext private keys, client secrets, bearer tokens, or subject claims.
- Must not fail open on policy, key, revocation, replay, or signing errors.
- Must not import from `caracalEnterprise/`.

## Validation
- Validate with `go test ./services/sts/...` when STS code changes.
