# packages/oauth/python

## Scope
- Covers the `caracalai-oauth` Python package under `packages/oauth/python/`.

## Architecture Design
- The package provides an httpx-backed RFC 8693 token-exchange client, a client-secret exchanger with mandate caching and approval polling, exchange types, typed token-exchange errors, exchange events, and in-memory cache behavior.

## Required
- Must require Python 3.14+ through `pyproject.toml`.
- Must keep the public surface exported from `caracalai_oauth/__init__.py`.
- Must keep token caching in memory and scoped by subject token context.

## Forbidden
- Must not persist tokens to disk.
- Must not depend on identity, revocation, transport, framework, or service packages.
- Must not log token values.

## Validation
- Validate with the relevant `tests/python/unit/caracalai_oauth` tests.

