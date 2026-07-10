# packages

## Scope
- Covers reusable library packages under `packages/`.

## Architecture Design
- Domain packages use `<domain>/<language>/` when multiple language bindings exist.
- The framework-neutral verification engine lives under `verify/<language>/`.
- Framework adapters live under `adapters/<framework>/<language>/`.
- Storage backends live under `backends/<store>/<language>/`.
- Runnable services and apps consume packages; packages must not depend on apps or services.

## Required
- Must keep TypeScript packages listed in `pnpm-workspace.yaml`.
- Must keep Go modules listed in `go.work`.
- Must keep Python packages defined by their own `pyproject.toml`.
- Must preserve language boundaries and publishable package surfaces.
- Must route shared SDK primitives through `core` and TypeScript server primitives through `serverCore`, not ad hoc shared folders.

## Forbidden
- Must not contain runnable app or service entrypoints.
- Must not contain infrastructure orchestration.
- Must not import from sibling implementation internals when a public package surface exists.
- Must not add a framework or protocol adapter package when the target exposes an injectable HTTP client, an environment-variable credential path, a composable middleware or interceptor standard, or fetch-standard request handling; serve those targets with documentation recipes over `verify`.
- Must not import from `caracalEnterprise/`.

## Validation
- Validate with the touched package's declared build, typecheck, or test command.

