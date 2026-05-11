# connectors/express/ts

## Scope
- Covers only the `@caracalai/mcp-express` TS package under `packages/connectors/express/ts/`.

## Required
- Must adapt the `@caracalai/transport-mcp` `authenticate` result onto an Express `RequestHandler`.
- Must map every `AuthError` code to the matching HTTP status and JSON body.
- Must require a `RevocationStore` on the middleware options and forward it to `authenticate`.

## Forbidden
- Must not re-implement JWT verification or revocation lookup.
- Must not depend on FastMCP, net/http, or any storage backend.
