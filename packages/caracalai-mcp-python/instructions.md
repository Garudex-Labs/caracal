# caracalai-mcp-python

## Scope
- Covers only the Python `caracalai-mcp` package under `caracal/packages/caracalai-mcp-python/`.

## Required
- Must validate Caracal-issued JWTs using JWKS with 5-min cache.
- Must check `iss`, `aud`, `exp`, and scope on every request.
- Must support FastMCP middleware pattern.

## Forbidden
- Must not import from `caracalEnterprise/`.
- Must not log plaintext bearer tokens.
