# Caracal OAuth

`packages/oauth` owns RFC 8693 token exchange with Caracal STS. It exchanges an already-authenticated subject token for a scoped resource token and keeps OAuth flow behavior separate from identity verification, transport authentication, and revocation enforcement.

## Production contract

The client posts to `/oauth/2/token` with the token-exchange grant, validates successful STS responses, handles `interaction_required` challenge responses, retries transient STS failures within the caller deadline, and retries once after `401` so credential refresh hooks can recover without weakening authorization.

Token cache keys include the STS identity, hashed subject token, actor token, session and delegation identifiers, resource, scopes, TTL, and client-auth context. Cache entries are process-local and never persist token values.

## Language surfaces

| Language | Path | Package |
| --- | --- | --- |
| TypeScript | `packages/oauth/ts` | `@caracalai/oauth` |
| Go | `packages/oauth/go` | `github.com/garudex-labs/caracal/packages/oauth/go` |
| Python | `packages/oauth/python` | `caracalai-oauth` |

## Boundaries

OAuth does not verify JWTs, check revocation, issue tokens directly, persist secrets, implement browser redirect/callback handling, or make authorization decisions. Callers must verify inbound identity with `identity`, enforce revocation with `revocation`, and apply policy in the service boundary that owns the resource.

