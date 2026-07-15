# infra/postgres

## Scope
- Covers the PostgreSQL image, migrations, and database scripts under `infra/postgres/`.

## Architecture Design
- Numbered migrations define the canonical OSS schema.
- The Postgres image packages migrations and the `caracal-migrate` entrypoint used by Compose.
- Database roles, RLS, immutable audit/policy tables, and secret ciphertext storage are schema-owned concerns.

## Required
- Must use PostgreSQL 18 and port 5432.
- Must add production schema changes as forward-only `NNNN_*.up.sql` files.
- Must keep `NNNN_*.down.sql` files as developer-local reset aids only.
- Must name migrations after the schema change they make (for example `0002_add_authority_indexes`), never after a release version, because the stable release that ships a migration is unknown until promotion.
- Must put all schema changes since the last stable release in the single open migration pair (the one not listed in `migrations/released.sha256`); its contents and filename may be rewritten, squashed, combined, or renamed freely until a stable release ships it.
- Must treat every stable release as the freeze boundary: when any `vX.Y.Z` component changes (major, minor, or patch), the migrations it ships become immutable in both name and content.
- Must start a new migration pair with the next sequential prefix for any schema change after a stable release ships.
- Must regenerate `migrations/released.sha256` with `scripts/freezeMigrations.sh` when a stable release ships.
- Must preserve audit append-only behavior and policy-version immutability.
- Must store secrets only as ciphertext with nonce and DEK metadata.

## Forbidden
- Must not edit or rename any migration listed in `migrations/released.sha256`.
- Must not create more than one open migration pair between stable releases.
- Must not include release versions in migration filenames.
- Must not reference `*.down.sql` from production tooling, Helm, Compose, or CI release paths.
- Must not grant UPDATE or DELETE on append-only audit records.
- Must not store plaintext private keys, credentials, tokens, or subject claims.
- Must not place service query code in this directory.

## Validation
- Validate migration changes with the Postgres scripts in `infra/postgres/scripts/`.
