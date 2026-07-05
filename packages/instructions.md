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
- Must route shared primitives through `core`, not ad hoc shared folders.

## Forbidden
- Must not contain runnable app or service entrypoints.
- Must not contain infrastructure orchestration.
- Must not import from sibling implementation internals when a public package surface exists.
- Must not import from `caracalEnterprise/`.

## Validation
- Validate with the touched package's declared build, typecheck, or test command.

