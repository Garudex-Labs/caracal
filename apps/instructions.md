# apps

## Scope
- Covers runnable TypeScript applications under `apps/`.

## Architecture Design
- `api/` is the Fastify control-plane API.
- `coordinator/` is the Fastify agent lifecycle and delegation coordinator.
- `cli/` is the command-line interface.
- `tui/` is the terminal UI.
- Shared execution and API logic belongs in `packages/engine` and `packages/admin`, not in app siblings.

## Required
- Must keep every app listed in `pnpm-workspace.yaml`.
- Must keep each app on Node 24+ with its own `package.json`, `tsconfig.json`, and `instructions.md`.
- Must keep per-app Dockerfiles only where the app owns its runtime image.
- Must route shared behavior through packages instead of importing from sibling apps.

## Forbidden
- Must not place Go microservices in this directory.
- Must not place reusable SDK, connector, or transport code in an app.
- Must not place infrastructure-wide Compose, Redis, or Postgres assets here.

## Validation
- Validate with the touched app's `build`, `typecheck`, or `test` script.

