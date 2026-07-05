# packages/adapters/express

## Scope
- Covers Express adapter package grouping under `packages/adapters/express/`.

## Architecture Design
- The current implementation is TypeScript-only under `ts/`.
- Express-specific middleware adapts verification-engine authentication to Express request handlers.

## Required
- Must keep generic authentication logic in `packages/verify`.
- Must keep Express-only behavior inside language subdirectories.

## Forbidden
- Must not host storage backends or transport-neutral authentication logic.
- Must not add non-Express adapters here.

## Validation
- Validate through the touched child package.

