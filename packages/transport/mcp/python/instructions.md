# transport/mcp/python

## Scope
- Covers only the `caracalai-transport-mcp` Python package under `packages/transport/mcp/python/`.

## Required
- Must consume only the `caracalai-identity` and `caracalai-revocation` packages.
- Must expose a transport-neutral `authenticate` coroutine returning a typed result.
- Must require a `RevocationStore` argument on `authenticate` and consult it for every authenticated session.

## Forbidden
- Must not depend on FastMCP, ASGI frameworks, or any storage backend.
