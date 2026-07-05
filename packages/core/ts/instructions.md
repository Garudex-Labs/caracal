# packages/core/ts

## Scope
- Covers the `@caracalai/core` TypeScript package under `packages/core/ts/`.

## Architecture Design
- The package provides the TypeScript SDK kernel: errors, scope, JSON types, logging, redaction, trace context, the audit client, and HMAC stream signing.
- It is the zero-dependency foundation for published TypeScript packages; server-only primitives live in `packages/serverCore/ts`.

## Required
- Must use TypeScript strict mode and NodeNext module resolution.
- Must keep `src/index.ts` as the public export surface.
- Must emit structured JSON logs to stderr.
- Must keep command catalog changes aligned with the Go mirror.

## Forbidden
- Must not add service-specific or app-specific logic.
- Must not add runtime npm dependencies; the kernel ships with none.
- Must not log raw secrets or tokens.

## Validation
- Validate with `pnpm --dir packages/core/ts build`, `pnpm --dir packages/core/ts test`, and catalog parity tests when command data changes.

