# connectors/nethttp/go

## Scope
- Covers only the `github.com/garudex-labs/caracal/mcp-nethttp` Go module under `packages/connectors/nethttp/go/`.

## Required
- Must adapt `transport-mcp.Authenticate` results onto an `http.Handler`.
- Must map every `AuthError` code to the matching HTTP status and JSON body.

## Forbidden
- Must not perform JWT verification or revocation lookup directly.
- Must not depend on any storage backend.
