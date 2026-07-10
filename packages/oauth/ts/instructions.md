# packages/oauth/ts

## Scope
- Covers the `@caracalai/oauth` TypeScript package under `packages/oauth/ts/`.

## Architecture Design
- The package implements RFC 8693 token exchange against STS `/oauth/2/token`.
- It owns `TokenCache`, `InMemoryTokenCache`, exchange types, and `ApprovalRequiredError`.

## Required
- Must use TypeScript strict mode and keep exports through `src/index.ts`.
- Must perform pre-flight expiry checks before reusing cached tokens.
- Must retry once on 401 only when the existing token is stale or rejected.
- Must scope cache entries by subject token context.

## Forbidden
- Must not persist tokens to disk.
- Must not depend on identity, revocation, transport, framework, or provider SDK packages.
- Must not proactively refresh tokens without a caller exchange request.
- Must not log token values.

## Validation
- Validate with `pnpm --dir packages/oauth/ts build` and `pnpm --dir packages/oauth/ts test`.
