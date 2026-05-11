# connectors/express

## Scope
- Covers the per-language Express adaptors for Caracal MCP authentication.

## Required
- Each language subdirectory must adapt the `transport-mcp` core onto Express middleware.

## Forbidden
- Must not host generic auth logic that belongs in `transport-mcp`.
