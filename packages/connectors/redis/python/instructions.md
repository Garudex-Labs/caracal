# connectors/redis/python

## Scope
- Covers only the `caracalai-revocation-redis` Python package.

## Required
- Must implement the `caracalai_revocation.RevocationStore` protocol.
- Must use structural Redis client calls so callers can provide compatible Redis clients.
- Must keep stream-consumer logic independent of MCP, FastMCP, and identity packages.

## Forbidden
- Must not verify JWTs or own request authentication.
