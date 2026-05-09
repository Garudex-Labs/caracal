# caracalai-mcp/go

## Scope
- Covers only the Go `net/http` middleware under `caracal/packages/caracalai-mcp/go/`.

## Required
- Must wire bearer-token extraction and HTTP error responses to `github.com/garudex-labs/caracal/identity` for JWT verify, JWKS, and scope evaluation.
- Must be listed in `go.work` at the workspace root.

## Forbidden
- Must not implement JWT verify, JWKS fetch, scope parsing, or claim types in this package.
- Must not import from `caracalEnterprise/`.
- Must not log plaintext bearer tokens.
