# apps

## Scope
- Covers TypeScript/Node.js applications under this directory, including any embedded helper binaries packaged into the same app image.

## Required
- Must contain a TS/Node application as the primary entrypoint, each with its own `package.json`.
- Must be listed in `pnpm-workspace.yaml` at the `caracal/` root.
- Must name directories by application identity (e.g. `api`, `cli`, `coordinator`).
- May colocate a Go sub-module under `<app>/relay/` (or similar) only when it is built into and shipped inside the same container as the TS app.

## Forbidden
- Must not contain standalone Go services with an independent lifecycle; those belong in `services/`.
- Must not contain infra configuration (Docker Compose, SQL, Redis config) outside per-app `Dockerfile`s.
- Must not place shared library code here; shared TS code belongs in `packages/ts-*` and shared Go code in `packages/core/go/`.
