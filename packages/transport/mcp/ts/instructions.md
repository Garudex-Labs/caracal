# transport/mcp/ts

## Scope
- Covers only the `@caracalai/transport-mcp` TS package under `packages/transport/mcp/ts/`.

## Required
- Must consume only the `@caracalai/identity` and `@caracalai/revocation` interfaces.
- Must expose a transport-neutral `authenticate` function returning a typed `Result<Principal, AuthError>`.
- Must require a `RevocationStore` on every `authenticate` call and consult it for every authenticated session.

## Forbidden
- Must not depend on Express, FastMCP, net/http, or any framework runtime.
- Must not depend on any storage backend or database driver.
