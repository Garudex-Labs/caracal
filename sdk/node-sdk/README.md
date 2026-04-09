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

const principals = await client.principals.list();
const mandate = await client.mandates.create({
  principalId: "principal_001",
  allowedOperations: ["read", "write"],
  expiresIn: 3600,
});
```

## Runtime Endpoint

The SDK resolves the runtime endpoint from `CARACAL_API_URL` first, then
falls back to `http://localhost:${CARACAL_API_PORT:-8000}`.

```bash
export CARACAL_API_PORT=8000
export CARACAL_API_URL=http://localhost:8000
```

## License

AGPLv3 — see LICENSE.  
Enterprise extensions (`src/enterprise/`) are proprietary.
