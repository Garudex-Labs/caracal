# packages

## Scope
- Covers only library packages under this directory.

## Required
- Must place each package under a single domain directory containing one subdirectory per language (`ts/`, `go/`, `python/`).
- Must place wire-protocol packages under `transport/<protocol>/<language>/` (e.g. `transport/mcp`, `transport/a2a`).
- Must place every framework or storage connector under `connectors/<single-word>/<language>/` (e.g. `connectors/express`, `connectors/postgres`).
- Must give every Go package its own `go.mod` and list it in `go.work`.
- Must give every TS package its own `package.json` and list it in `pnpm-workspace.yaml`.
- Must give every Python package its own `pyproject.toml`.

## Forbidden
- Must not contain runnable services or applications.
- Must not contain infra configuration.
- Must not duplicate logic already owned by a sibling package.
- Must not import across the `caracal/` and `caracalEnterprise/` product boundary.
- Must not introduce a top-level `shared/` or `ts-shared/` directory; the foundation lives under `core/`.
- Must not reintroduce the legacy `framework-adaptor/`, `runtime-adaptor/`, or `state-backend/` directories; all adapters live under `connectors/`.
