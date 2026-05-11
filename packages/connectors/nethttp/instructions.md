# connectors/nethttp

## Scope
- Covers the per-language `net/http` adaptors for Caracal MCP authentication.

## Required
- Each language subdirectory must adapt the `transport-mcp` core onto the standard library HTTP shape.

## Forbidden
- Must not host generic auth logic that belongs in `transport-mcp`.
