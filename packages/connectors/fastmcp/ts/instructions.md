# connectors/fastmcp/ts

## Scope
- Covers only the `@caracalai/mcp-fastmcp` TS package under `packages/connectors/fastmcp/ts/`.

## Required
- Must call `authenticate` from `@caracalai/transport-mcp` for every token verification.
- Must expose only the FastMCP-shaped binding for token validation.

## Forbidden
- Must not import `jose`, perform JWKS fetches, or implement JWT verification directly.
- Must not depend on Express, net/http, or any storage backend.
