# packages/sdk/python

## Scope
- Covers the `caracalai-sdk` Python package under `packages/sdk/python/`.

## Architecture Design
- The package exposes `Caracal`, context, coordinator, envelope, ASGI middleware, JSON types, and lifecycle primitives.
- It consumes identity/OAuth-compatible behavior through public package surfaces.

## Required
- Must require Python 3.14+ through `pyproject.toml`.
- Must keep the public surface exported from `caracalai/__init__.py`.
- Must preserve context propagation, delegation constraints, and envelope semantics.
- Must keep ASGI helpers optional and framework-shaped without owning app code.

## Forbidden
- Must not implement STS policy evaluation, revocation storage, or JWT verification internals.
- Must not depend on examples, apps, or services.
- Must not log or persist bearer tokens.

## Validation
- Validate with the relevant `tests/python/unit/caracalai` tests.

