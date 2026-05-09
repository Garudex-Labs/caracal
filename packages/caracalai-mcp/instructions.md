# caracalai-mcp

## Scope
- Covers the per-language `caracalai-mcp` packages.

## Required
- Each language subdirectory must own one MCP server auth middleware implementation.
- Each language subdirectory must wire bearer-token verification to the matching `identity` package for JWT verify, JWKS, scope, and claim shapes.
- Each language subdirectory must consult the matching `revocation` package on every authenticated request when the language exposes that capability.

## Forbidden
- Must not implement JWT verify, JWKS fetch, scope parsing, or claim types in this package.
- Must not import from `caracalEnterprise/`.
- Must not log plaintext bearer tokens.
