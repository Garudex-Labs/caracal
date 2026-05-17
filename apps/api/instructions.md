# apps/api

## Scope
- Covers the `@caracalai/api` Fastify control-plane service under `apps/api/`.

## Architecture Design
- Routes under `src/routes/` own zone, application, resource, provider, policy, grant, session, invitation, team, and step-up APIs.
- `src/db.ts`, `src/outbox.ts`, `src/redis.ts`, and `src/admin-audit.ts` own persistence, stream publishing, and admin audit integration.
- The service listens on port 3000 in Compose and depends on PostgreSQL, Redis, STS, and migrations.

## Required
- Must run on Node 24+ with Fastify 5, Zod validation, `pg`, `ioredis`, and `@caracalai/core`.
- Must validate request input before database or Redis access.
- Must publish policy, session, key, and lifecycle invalidation events through the outbox or owning stream helper.
- Must redact secrets and never return plaintext key material.
- Must keep admin audit persistence through `@caracalai/admin-audit`.

## Forbidden
- Must not accept Cedar policies or add a second policy language.
- Must not expose raw database URLs, Redis URLs, passwords, tokens, or decrypted secrets.
- Must not bypass request auth, zone guards, or input schemas in route handlers.
- Must not import from sibling apps or `caracalEnterprise/`.

## Validation
- Validate with `pnpm --dir apps/api build` and `pnpm --dir apps/api test` when API code changes.

