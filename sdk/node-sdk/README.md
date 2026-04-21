# @caracal/core — Node.js SDK

> Pre-execution authority enforcement SDK for delegated principals.  
> Mirrors the Python `caracal-core` SDK API surface exactly.

## Installation

```bash
npm install @caracal/core
```

## Quick Start

```typescript
import { CaracalClient } from "@caracal/core";

const client = new CaracalClient({ apiKey: "sk_test_123" });

const result = await client.tools.call({
  toolId: "provider:github:resource:issues:action:create",
  toolArgs: { title: "Investigate regression" },
});
```

## Scoped Runtime Calls

```typescript
import { CaracalClient } from "@caracal/core";

const client = new CaracalClient({ apiKey: "sk_test_123" });
const ctx = client.context.checkout({
  workspaceId: "ws_xyz789",
});

const result = await ctx.tools.call({
  toolId: "provider:slack:resource:messages:action:post",
  toolArgs: { channel: "alerts", text: "Runtime check complete" },
});
```

## SDK Scope

- Includes: client, context, tools bridge, hooks/extensions, adapters, runtime endpoint helpers.
- Excludes: control-plane admin APIs such as principals, mandates, delegation, policy, and ledger CRUD.
- Excludes: caller-provided mandate or policy selection in runtime tool calls.

Control-plane ownership remains in Caracal runtime (OSS broker path) and enterprise gateway layers.

## Runtime Endpoint

The SDK resolves the runtime endpoint from `CARACAL_API_URL` first, then
falls back to `http://localhost:${CARACAL_API_PORT:-8000}`.

```bash
export CARACAL_API_PORT=8000
export CARACAL_API_URL=http://localhost:8000
```

## License

Apache 2.0 — see LICENSE.  
Enterprise extensions (`src/enterprise/`) are proprietary.
