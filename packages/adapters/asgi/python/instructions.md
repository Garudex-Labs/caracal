# packages/adapters/asgi/python

## Scope
- Covers the `caracalai-asgi` Python package under `packages/adapters/asgi/python/`.

## Architecture Design
- The package adapts `caracalai_verify` verification to the ASGI protocol.
- It is framework-neutral: it must run under FastAPI, Starlette, Quart, or any ASGI server without importing any of them.

## Required
- Must call `caracalai_verify` (`MandateVerifier`/`authenticate`) for token verification.
- Must require a caller-provided revocation store and forward it to verify-engine authentication.
- Must answer failed verification with `http_status_for_auth_error` and the standard `error`/`error_description` JSON shape.
- Must expose verified claims as `scope["state"]["caracal"]`.

## Forbidden
- Must not implement JWT verification, JWKS fetching, or revocation lookup directly.
- Must not import FastAPI, Starlette, or any web framework.
- Must not pass unauthenticated HTTP or WebSocket requests to the application, except paths listed in `exclude`.

## Validation
- Validate with the relevant `tests/python/unit/caracalai_asgi` tests.
