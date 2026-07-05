# packages/adapters/fastmcp/python

## Scope
- Covers the `caracalai-fastmcp` Python package under `packages/adapters/fastmcp/python/`.

## Architecture Design
- The package adapts `caracalai_verify.authenticate` to FastMCP authentication hooks.
- FastMCP support is optional through package extras.

## Required
- Must require Python 3.14+ through `pyproject.toml`.
- Must call `caracalai_verify.authenticate` for token verification.
- Must require caller-provided revocation behavior and forward it to verify-engine authentication.

## Forbidden
- Must not implement JWT verification, JWKS fetching, or revocation lookup directly.
- Must not depend on Express, Go net/http, or Redis.
- Must not pass unauthenticated requests to FastMCP handlers.

## Validation
- Validate with the relevant `tests/python/unit/caracalai_fastmcp` tests.

