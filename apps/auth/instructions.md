# apps/auth

## Scope
- Covers the `@caracalai/auth` Community Edition authentication service under `apps/auth/`.

## Architecture Design
- `src/auth.ts` owns the Better Auth instance and enabled capabilities.
- `src/providers.ts` owns provider credential resolution and the enabled-provider report.
- `src/server.ts` exposes the Better Auth handler over HTTP with CORS for the web client.
- `src/config.ts` owns runtime configuration and defaults, including database connection.
- `src/database.ts` builds the PostgreSQL pool and ensures the auth database exists.
- `src/migrate.ts` creates or updates the authentication schema.

## Database
- Runs on PostgreSQL in every environment — one uniform backend for development and production.
- The connection string comes from `CARACAL_AUTH_DATABASE_URL` (falling back to `DATABASE_URL`), both `_FILE`-secret aware. `caracal web` points it at the dev stack's Postgres automatically.
- The auth database is created on startup if absent (when the role may create databases); Better Auth then runs the schema migrations.
- The signing secret comes from `CARACAL_AUTH_SECRET` (provisioned automatically by `caracal web`); the service fails closed without one.
- Account deletion goes through Better Auth's adapter so the cascade is backend-correct.

## Required
- Must own operator identity only: authentication, sessions, and Better Auth capabilities.
- Must keep authority, policy, delegation, and zone state in Caracal services, not here.
- Must run on Node 22+ and bind to port 3002.
- Must restrict CORS to the configured web origin and keep credentials enabled.
- Must enable a social provider only when both its client id and client secret are configured.
- Must link email, Google, and GitHub identities for one operator through account linking.

## Forbidden
- Must not reuse open-source ports 3000, 3001, 4000, 5432, 6379, 8080, 8081, 8087, or 9090.
- Must not import or copy source from `caracalEnterprise/`.
- Must not implement Caracal authority or policy logic.

## Validation
- Validate with `pnpm --dir apps/auth typecheck` and `pnpm --dir apps/auth lint`.
