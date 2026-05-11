# connectors/postgres/ts

## Scope
- Covers only the `@caracalai/tokenstate-postgres` TS package under `packages/connectors/postgres/ts/`.

## Required
- Must persist per-subject MCP token state (sub, scope, expiresAt) in PostgreSQL only.
- Must depend only on the `pg` driver.

## Forbidden
- Must not implement the `@caracalai/revocation` interface.
- Must not import any transport, framework, or identity package.
