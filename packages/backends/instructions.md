# packages/backends

## Scope
- Covers storage backend package groupings under `packages/backends/`.

## Architecture Design
- Each child directory implements a storage-backed interface owned by a core package, such as the `packages/revocation` store contract.
- Backends use `<store>/<language>/` when multiple language bindings exist.

## Required
- Must implement an interface owned by a core package; the interface contract stays in the owning package.
- Must keep driver-specific behavior inside language subdirectories.
- Must fail closed on lookup errors unless a caller-facing API explicitly exposes a safe testing mode.

## Forbidden
- Must not perform JWT verification or own request authentication.
- Must not import framework adapters or transport packages.
- Must not store plaintext bearer tokens or claims.

## Validation
- Validate through the touched child package's declared build or test command.
