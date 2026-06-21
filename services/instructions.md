# services

## Scope
- Covers independently deployed Go services under `services/`.

## Architecture Design
- `sts/`, `gateway/`, and `audit/` are separate Go modules listed in `go.work`.
- Shared Go behavior belongs in `packages/core/go` or another package module, never in a service sibling.
- Service images are built by shared Go-service Docker packaging under `infra/docker/`.

## Required
- Must keep every service self-contained with `go.mod`, `cmd/<service>/`, `internal/`, and its own `instructions.md`.
- Must keep public ports aligned with Compose.
- Must use `packages/core/go` for shared config, crypto, logging, errors, audit, metrics, and command catalog primitives.
- Must fail closed on missing required runtime configuration.

## Forbidden
- Must not place TypeScript apps, SDK packages, or infrastructure config in this directory.
- Must not import from sibling service internals.
- Must not share business logic by copying code across services.
- Must not import from `caracalEnterprise/`.

## Validation
- Validate with the owning `go test ./services/<name>/...` command or root Go test script.

