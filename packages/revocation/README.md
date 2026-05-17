# Caracal Revocation

`packages/revocation` owns the revocation lookup contract and the bounded in-memory default. Storage-backed implementations live in connector packages such as `packages/connectors/redis`.

## Production contract

Revocation decisions are authoritative for session and token invalidation. Resource servers must fail closed if revocation cannot be checked, if an accepted token lacks a session identifier, or if a revocation write cannot be confirmed by the backing store.

The in-memory store is process-local and suited for tests, local development, and single-process deployments. Distributed and self-hosted production deployments should use a connector-backed store with shared state and recovery behavior.

## Language surfaces

| Language | Path | Package |
| --- | --- | --- |
| TypeScript | `packages/revocation/ts` | `@caracalai/revocation` |
| Go | `packages/revocation/go` | `github.com/garudex-labs/caracal/packages/revocation/go` |
| Python | `packages/revocation/python` | `caracalai-revocation` |

## Boundaries

Revocation does not parse JWTs, define identity claims, manage OAuth exchange, run framework middleware, or own Redis/Postgres clients. It stays small so transport and connector packages can compose it safely without duplicating invalidation policy.

