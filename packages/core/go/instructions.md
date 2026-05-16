# core/go

## Scope
- Covers only the Go core foundation under `caracal/packages/core/go/`.

## Required
- Go packages (`config`, `errors`, `crypto`, `logging`, `audit`, `scope`, `sts`, `commands`) live directly in this directory under the module `github.com/garudex-labs/caracal/core`.
- Every Go service must import core utilities only from `github.com/garudex-labs/caracal/core/*`.
- `crypto` package must wrap ChaCha20-Poly1305 and ECDSA P-256 primitives only; no raw cipher usage outside this package.
- `logging` package must produce structured JSON on stderr; no plaintext log lines elsewhere.
- `commands` package must mirror the canonical TS catalog at `packages/core/ts/src/commands.ts`; parity is enforced by `tests/typescript/scripts/catalog-parity.test.ts`.

## Forbidden
- Must not add platform-specific dependencies to the core layer.
- Must not embed service-specific business logic.
- Must not add packages beyond those listed above without updating this file.
