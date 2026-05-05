# caracalai-cloudflare

## Scope
- Covers only the `@caracalai/cloudflare` package under `caracal/packages/caracalai-cloudflare/`.

## Required
- Must use Web Crypto and fetch only; no Node-only APIs.
- Must implement `IsolateSafeTokenCache` keyed by `${subject}::${resource}`.
- Must ensure tokens cannot leak across subjects even when isolates are reused.
- Must support Workers runtime as the build target.

## Forbidden
- Must not import from `caracalEnterprise/`.
- Must not use Node-only modules (fs, path, crypto from node:, etc.).
- Must not share cache entries across subjects.
- Must not persist tokens to KV or Durable Objects in v1.
- Must not log token values.
