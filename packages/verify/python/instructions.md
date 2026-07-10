# packages/verify/python

## Scope
- Covers the `caracalai-verify` Python package under `packages/verify/python/`.

## Architecture Design
- The package authenticates Caracal JWTs with `caracalai_identity` and checks revocation through `caracalai_revocation`.

## Required
- Must require Python 3.14+ through `pyproject.toml`.
- Must expose transport-neutral authentication returning typed results.
- Must require caller-provided revocation behavior for every authenticated session.

## Forbidden
- Must not depend on FastMCP, ASGI frameworks, Redis, or service internals.
- Must not perform storage lookups except through the revocation protocol.
- Must not log plaintext tokens.

## Validation
- Validate with the relevant `tests/python/unit/caracalai_verify` tests.

