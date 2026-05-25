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
- Must keep committed migrations immutable after merge.
- Must preserve audit append-only behavior and policy-version immutability.
- Must store secrets only as ciphertext with nonce and DEK metadata.

## Forbidden
- Must not edit a committed migration in place.
- Must not reference `*.down.sql` from production tooling, Helm, Compose, or CI release paths.
- Must not grant UPDATE or DELETE on append-only audit records.
- Must not store plaintext private keys, credentials, tokens, or subject claims.
- Must not place service query code in this directory.

## Validation
- Validate migration changes with the Postgres scripts in `infra/postgres/scripts/`.
