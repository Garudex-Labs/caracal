# apps/coordinator

## Scope
- Covers the `@caracalai/coordinator` Fastify agent lifecycle service under `apps/coordinator/`.

## Architecture Design
- Routes under `src/routes/` own agents, agent services, delegations, and invocations.
- Jobs under `src/jobs/` enforce deadlines, TTLs, retention, and outbox publishing.
- PostgreSQL owns authoritative agent state; Redis Streams distribute lifecycle and delegation events.
- The service listens on port 4000 in Compose.

## Required
- Must run on Node 24+ with Fastify, Zod, PostgreSQL, Redis, JOSE, and `@caracalai/core`.
- Must enforce configured agent depth, child, zone, and application limits before mutation.
- Must use database transactions and advisory locks for graph mutations, cascades, and spawn-cap enforcement.
- Must publish lifecycle, invocation, delegation, and invalidation events through the outbox path.
- Must authenticate lifecycle and delegation callers before mutating state.

## Forbidden
- Must not bypass lifecycle cascades for terminate, suspend, resume, TTL expiry, or delegation revoke.
- Must not store plaintext credentials, bearer tokens, or unredacted claims.
- Must not write directly to Redis Streams from request handlers when the outbox owns the event.
- Must not import from sibling apps or `caracalEnterprise/`.

## Validation
- Validate with `pnpm --dir apps/coordinator build` and `pnpm --dir apps/coordinator test` when coordinator code changes.

