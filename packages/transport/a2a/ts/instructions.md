# transport/a2a/ts

## Scope
- Covers only the `@caracalai/transport-a2a` TS package under `packages/transport/a2a/ts/`.

## Required
- Must implement A2A protocol primitives: subject token preservation, scope subset enforcement, message envelope.
- Must remain agent-agnostic and reusable by any service performing A2A calls.
- Must route token exchange through `@caracalai/oauth`.

## Forbidden
- Must not import any agent runtime, framework SDK, or storage backend.
- Must not allow scope escalation across hops.
- Must not log plaintext tokens.
