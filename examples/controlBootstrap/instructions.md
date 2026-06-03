# examples/controlBootstrap

## Scope
- Covers the non-interactive Control API provisioning example under `examples/controlBootstrap/`.

## Architecture Design
- `controlClient.mjs` exchanges a scoped control key for a short-lived STS token and calls `POST /v1/control/invoke`.
- `provisionPlan.mjs` is the single source of truth for the demo objects, required scopes, and env-driven config.
- `bootstrap.mjs` and `teardown.mjs` drive idempotent create and reverse-order delete through the Control API.

## Required
- Must use only the public Control API and STS HTTP surfaces, never repository internals.
- Must keep the demo objects, scopes, and client config defined in `provisionPlan.mjs`.
- Must keep tests offline with a mock fetch.
- Must run on Node `>=22`.

## Forbidden
- Must not add management verbs to the runtime CLI or call Console internals.
- Must not commit client secrets or upstream credentials.
- Must not call a live Caracal stack from tests.

## Validation
- Validate with `node --test "tests/**/*.test.mjs"` from this directory.
