# connectors/postgres

## Scope
- Covers the per-language Postgres-backed token state binding.

## Required
- Each language subdirectory must implement the token state interface against Postgres.

## Forbidden
- Must not host token cache, transport, or framework logic.
