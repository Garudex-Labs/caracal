# packages/adapters/nethttp

## Scope
- Covers Go net/http adapter package grouping under `packages/adapters/nethttp/`.

## Architecture Design
- The current implementation is Go-only under `go/`.
- net/http middleware adapts verification-engine authentication to standard-library handlers.

## Required
- Must keep generic authentication logic in `packages/verify`.
- Must keep Go standard-library HTTP behavior inside `go/`.

## Forbidden
- Must not host storage backends or transport-neutral authentication logic.
- Must not add framework-specific adapters here.

## Validation
- Validate through the touched child module.

