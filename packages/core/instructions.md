# packages/core

## Scope
- Covers cross-cutting foundation packages under `packages/core/`.

## Architecture Design
- `ts/`, `go/`, and `python/` own language-specific implementations of shared primitives.
- Core owns the SDK kernel: errors, scope, JSON, logging, audit, and stream signing.
- `go/` additionally retains server primitives consumed by Go services; the TypeScript server primitives live in `packages/serverCore/ts`.

## Required
- Must keep implementation code inside language subdirectories.
- Must keep core primitives free of service, app, framework, and storage business logic.
- Must keep language surfaces consistent where a primitive exists in multiple languages.

## Forbidden
- Must not place source files at this level.
- Must not introduce cross-language imports or generated coupling between language packages.
- Must not add runtime-specific adapters here.

## Validation
- Validate through the touched child package and any parity tests covering shared surfaces.

