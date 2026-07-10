# packages/adapters/fastmcp/ts

## Scope
- Covers the `@caracalai/fastmcp` TypeScript package under `packages/adapters/fastmcp/ts/`.

## Architecture Design
- The package adapts `@caracalai/verify` authentication to FastMCP token-validation hooks.

## Required
- Must call `@caracalai/verify` for token authentication.
- Must keep FastMCP request shaping local to this package.
- Must keep exported types usable without importing app or service code.

## Forbidden
- Must not import `jose` or implement JWT verification directly.
- Must not depend on Express, Go net/http, or Redis.
- Must not pass unauthenticated requests to FastMCP handlers.

## Validation
- Validate with `pnpm --dir packages/adapters/fastmcp/ts build` and its adapter tests.

