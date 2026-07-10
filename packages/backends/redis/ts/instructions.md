# packages/backends/redis/ts

## Scope
- Covers the `@caracalai/revocation-redis` TypeScript package under `packages/backends/redis/ts/`.

## Architecture Design
- The package implements the `@caracalai/revocation` store interface with Redis-compatible structural clients and stream-consumer helpers.

## Required
- Must keep Redis client requirements structural.
- Must keep stream-consumer logic independent from verify, Express, FastMCP, and identity packages.
- Must verify stream signatures when configured.

## Forbidden
- Must not verify JWTs or own request authentication.
- Must not depend on transport or framework packages.
- Must not log raw token identifiers beyond approved fingerprints or keys.

## Validation
- Validate with `pnpm --dir packages/backends/redis/ts build` and its backend tests.

