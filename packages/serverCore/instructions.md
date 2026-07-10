# packages/serverCore

## Scope
- Covers the internal server-foundation package grouping under `packages/serverCore/`.

## Architecture Design
- The current implementation is TypeScript-only under `ts/`.
- This package owns server-side primitives for Caracal apps: telemetry, env, secrets discovery, envelope crypto, assertions, and lifecycle.

## Required
- Must keep implementation code inside language subdirectories.
- Must keep primitives free of route handling and storage business logic.
- Must stay private; only apps and internal packages may depend on it.

## Forbidden
- Must not expose a public SDK surface from this level.
- Must not be published to a package registry.
- Must not be imported by published SDK packages.

## Validation
- Validate through the touched child package.
