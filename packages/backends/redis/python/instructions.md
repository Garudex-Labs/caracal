# packages/backends/redis/python

## Scope
- Covers the `caracalai-revocation-redis` Python package under `packages/backends/redis/python/`.

## Architecture Design
- The package implements `caracalai_revocation.RevocationStore` with Redis-compatible structural clients.

## Required
- Must require Python 3.14+ through `pyproject.toml`.
- Must keep Redis calls structural so callers can provide compatible clients.
- Must keep stream-consumer logic independent from verify, FastMCP, and identity packages.

## Forbidden
- Must not verify JWTs or own request authentication.
- Must not depend on transport or framework packages.
- Must not log raw token identifiers beyond approved fingerprints or keys.

## Validation
- Validate with the relevant `tests/python/unit/caracalai_revocation_redis` tests.

