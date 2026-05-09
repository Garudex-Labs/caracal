# framework-adaptor

## Scope
- Covers the framework-specific transport and agent adaptors grouped by framework.

## Required
- Each `mcp-*` child must wrap exactly one framework binding around the `transport-mcp` core.
- Each `agent-*` child must wrap exactly one framework binding around the `@caracalai/sdk` primitives (`withAgent`, `withDelegation`, context envelope).

## Forbidden
- Must not implement JWT verification, JWKS fetch, or revocation lookup directly.
- Must not duplicate identity, delegation, or token-exchange logic; route through `@caracalai/sdk`.
