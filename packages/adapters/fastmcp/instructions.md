# packages/adapters/fastmcp

## Scope
- Covers FastMCP adapter package grouping under `packages/adapters/fastmcp/`.

## Architecture Design
- TypeScript and Python child packages adapt verification-engine authentication to FastMCP host shapes.

## Required
- Must keep generic authentication logic in `packages/verify`.
- Must keep FastMCP-specific request and middleware shaping inside child packages.

## Forbidden
- Must not host storage backends or transport-neutral authentication logic.
- Must not add non-FastMCP adapters here.

## Validation
- Validate through the touched child package.

