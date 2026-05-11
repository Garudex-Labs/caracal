# connectors/fastmcp/python

## Scope
- Covers only the `caracalai-mcp-fastmcp` Python package under `packages/connectors/fastmcp/python/`.

## Required
- Must call `authenticate` from `caracalai_transport_mcp` for every token verification.
- Must expose only the FastMCP-shaped binding for token validation.
- Must require a `RevocationStore` on `CaracalAuth` construction and forward it to `authenticate`.

## Forbidden
- Must not implement JWT verification or revocation lookup directly.
- Must not depend on Express, net/http, or any storage backend.
