# packages/verify/ts

## Scope
- Covers the `@caracalai/verify` TypeScript package under `packages/verify/ts/`.

## Architecture Design
- The package authenticates Caracal JWTs with `@caracalai/identity` and checks revocation through `@caracalai/revocation`.

## Required
- Must use TypeScript strict mode and expose a transport-neutral `authenticate` result.
- Must require caller-provided revocation behavior for every authenticated session.
- Must keep auth errors typed for adapter mapping.

## Forbidden
- Must not depend on Express, FastMCP, Go net/http, Redis, or service internals.
- Must not perform storage lookups except through the revocation interface.
- Must not log plaintext tokens.

## Validation
- Validate with `pnpm --dir packages/verify/ts build` and `pnpm --dir packages/verify/ts test`.
