# transport/mcp/go

## Scope
- Covers only the `github.com/garudex-labs/caracal/transport-mcp` Go module under `packages/transport/mcp/go/`.

## Required
- Must consume only the `identity` and `revocation` Go modules.
- Must expose a framework-neutral `Authenticate` returning a typed result.

## Forbidden
- Must not depend on `net/http`, FastMCP, Express, or any storage backend.
- Must not import driver libraries or cross-package wrappers.
