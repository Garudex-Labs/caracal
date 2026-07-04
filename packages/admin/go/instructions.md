# packages/admin/go

## Scope
- Covers the Go admin client module under `packages/admin/go/`.

## Architecture Design
- The module exposes `ControlClient`, `AdminClient`, and the `Ensure` reconciler family in one package, mirroring the `@caracalai/admin` TypeScript surface.

## Required
- Must use Go 1.26 and depend only on the standard library and `packages/core/go`.
- Must keep `AuthorGrantsDocument` output byte-identical to the TypeScript renderer for the same grant set.
- Must mint control tokens per invoke and never persist or log client secrets.
- Must retry only idempotent (GET/HEAD) admin requests.

## Forbidden
- Must not depend on the SDK, identity, revocation, transport, or service siblings.
- Must not log token or secret values.
- Must not add read-only console surfaces beyond the provisioning subset.

## Validation
- Validate with `go test ./packages/admin/go/...` after staging tests from `tests/source/go/packages/admin/go/`.
