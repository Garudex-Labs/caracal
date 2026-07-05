# packages/admin/python

## Scope
- Covers the `caracalai-admin` Python package under `packages/admin/python/`.

## Architecture Design
- The package provides the control-plane invoke client, the admin API client (provisioning and operations surfaces), identifier helpers, and idempotent provisioning reconcilers, mirroring the `@caracalai/admin` TypeScript surface.

## Required
- Must keep the public surface exported from `caracalai_admin/__init__.py`.
- Must keep `author_grants_document` output byte-identical to the TypeScript renderer for the same grant set.
- Must mint control tokens per invoke and never persist or log client secrets.
- Must retry only idempotent (GET/HEAD) admin requests.
- Must keep the client surface at capability parity with the `@caracalai/admin` TypeScript client.

## Forbidden
- Must not depend on the SDK, identity, revocation, transport, or service packages.
- Must not log token or secret values.

## Validation
- Validate with the `tests/python/unit/caracalai_admin` tests.
