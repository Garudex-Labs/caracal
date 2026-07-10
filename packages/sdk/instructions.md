# packages/sdk

## Scope
- Covers per-language Caracal SDK packages under `packages/sdk/`.

## Architecture Design
- SDK packages provide the application-facing Caracal client surface for context propagation, Sessions, Delegations, Coordinator calls, transport helpers, envelopes, and lifecycle hooks.
- OAuth token exchange is consumed through `packages/oauth`.

## Required
- Must keep each language implementation in its own child directory.
- Must keep SDK surfaces focused on application integration, not service internals.
- Must preserve context and delegation semantics consistently across languages.

## Forbidden
- Must not implement STS policy evaluation, JWT verification internals, or revocation storage.
- Must not depend on apps, services, or connector siblings.
- Must not persist tokens unless an explicit public API contract introduces a secure store.

## Validation
- Validate through the touched child package and SDK tests for that language.

