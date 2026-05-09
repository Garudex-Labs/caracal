# caracalai-mcp/python

## Scope
- Covers only the Python `caracalai-mcp` package under `caracal/packages/caracalai-mcp/python/`.

## Required
- Must wire FastMCP middleware to `caracalai_identity` for JWT verify, JWKS, scope, and claim shapes.
- Must support FastMCP middleware pattern.

## Forbidden
- Must not implement JWT verify, JWKS fetch, scope parsing, or claim types in this package.
- Must not import from `caracalEnterprise/`.
- Must not log plaintext bearer tokens.
