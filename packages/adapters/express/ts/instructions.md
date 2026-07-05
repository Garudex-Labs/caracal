# packages/adapters/express/ts

## Scope
- Covers the `@caracalai/express` TypeScript package under `packages/adapters/express/ts/`.

## Architecture Design
- The package adapts `@caracalai/verify` authentication results to Express `RequestHandler` middleware.
- Express is a peer dependency; Caracal auth logic stays in the verify and SDK packages.

## Required
- Must map authentication errors to HTTP responses through `httpStatusForAuthError` from `@caracalai/verify`; never re-derive status codes locally.
- Must require caller-provided revocation behavior through middleware options.
- Must keep Express request augmentation minimal and typed.

## Forbidden
- Must not reimplement JWT verification, JWKS fetching, revocation lookup, or token exchange.
- Must not depend on FastMCP, Go net/http, or Redis.
- Must not pass unauthenticated requests to downstream handlers.

## Validation
- Validate with `pnpm --dir packages/adapters/express/ts build` and its adapter tests.

