# examples/controlBootstrap

## Scope
- Covers the Control API agent environment pipeline example under `examples/controlBootstrap/`.

## Architecture Design
- `controlClient.mjs` exchanges a scoped control key for a short-lived STS token and calls `POST /v1/control/invoke`.
- `plan.mjs` is the single source of truth for the desired agent environment, drift checks, per-stage scope tiers, and env-driven config.
- `apply.mjs`, `verify.mjs`, and `teardown.mjs` drive idempotent reconcile, read-only drift gating, and reverse-order delete through the Control API.

## Required
- Must use only the public Control API and STS HTTP surfaces, never repository internals.
- Must keep the desired state, drift checks, scope tiers, and client config defined in `plan.mjs`.
- Must keep `verify` read-only and `apply` idempotent.
- Must keep tests offline with a fake zone and mock fetch.
- Must run on Node `>=22`.

## Forbidden
- Must not add management verbs to the runtime CLI or call Console internals.
- Must not commit client secrets or upstream credentials.
- Must not call a live Caracal stack from tests.

## Validation
- Validate with `node --test "tests/**/*.test.mjs"` from this directory.
