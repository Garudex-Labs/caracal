# apps/control

## Scope
- Covers the `@caracalai/control` Fastify automation service under `apps/control/` that exposes `POST /v1/control/invoke` over the shared engine dispatch.

## Architecture Design
- `src/main.ts` boots Fastify, wires shutdown, and refuses to start unless `CARACAL_CONTROL_ENABLED=true`.
- `src/server.ts` registers `/health`, `/ready`, and `/v1/control/invoke`.
- `src/auth.ts` verifies ES256 STS-issued JWTs against zone-scoped JWKS and enforces per-resource scopes.
- `src/replay.ts`, `src/ratelimit.ts`, `src/audit.ts` provide JTI replay, per-subject token-bucket limiting, and audit emission.
- `src/handler.ts` calls `engine.dispatch` with a `remote` principal so CLI, TUI, and Control share one execution path.
- Listens on port 8087.

## Required
- Must run on Node 24+ with Fastify 5, `jose`, `ioredis`, and the workspace `@caracalai/engine`.
- Must default off and only start when `CARACAL_CONTROL_ENABLED=true`.
- Must require `CONTROL_REDIS_URL` and `AUDIT_HMAC_KEY` when `CARACAL_MODE` is `rc` or `stable`.
- Must enforce ES256 + issuer + audience + expiry on every request and derive scopes from the catalog.
- Must fail closed on Redis errors for replay checks.
- Must emit one audit event per request to `caracal.audit.events`.

## Forbidden
- Must not re-implement engine behavior: every dispatch goes through `engine.dispatch`.
- Must not expose hidden commands (`run`, `credential`, `control`, `completion`).
- Must not accept tokens without `zone_id` or without the per-command scope (`control:<command>:<verb>`).
- Must not log token values, client secrets, or HMAC keys.

## Validation
- Validate with `pnpm --dir apps/control typecheck` and `pnpm --dir apps/control test` when control code changes.
