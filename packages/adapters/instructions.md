# packages/adapters

## Scope
- Covers framework adapter package groupings under `packages/adapters/`.

## Architecture Design
- Each child directory adapts the verification engine in `packages/verify` to one framework or ecosystem: Express, ASGI, FastMCP, or Go net/http.
- Adapters use `<framework>/<language>/` when multiple language bindings exist.

## Required
- Must keep generic authentication logic in `packages/verify`.
- Must keep each adapter thin: bearer extraction, verification delegation, and framework response mapping only.
- Must map authentication errors through the verify engine's HTTP status helpers.

## Forbidden
- Must not host storage backends or transport-neutral authentication logic.
- Must not reimplement JWT verification, JWKS fetching, or revocation lookup.
- Must not import other adapters.

## Validation
- Validate through the touched child package's declared build or test command.
