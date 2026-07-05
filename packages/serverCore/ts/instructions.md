# packages/serverCore/ts

## Scope
- Covers the `@caracalai/server-core` TypeScript package under `packages/serverCore/ts/`.

## Architecture Design
- The package provides server-only primitives for Caracal apps: OpenTelemetry init, env accessors, secrets discovery, envelope encryption, gateway exchange signing, console token derivation, operator and account assertions, observability metrics, shutdown lifecycle, and URL helpers.
- It depends on `@caracalai/core` for kernel primitives and is the only TypeScript package that carries OpenTelemetry dependencies.

## Required
- Must use TypeScript strict mode and NodeNext module resolution.
- Must keep `src/index.ts` as the public export surface.
- Must keep `private: true` in package metadata.
- Must keep crypto formats aligned with the Go shared crypto package.

## Forbidden
- Must not add service-specific or app-specific logic.
- Must not be depended on by published SDK packages.
- Must not log raw secrets or tokens.

## Validation
- Validate with `pnpm --dir packages/serverCore/ts build` and `pnpm --dir packages/serverCore/ts test`.
