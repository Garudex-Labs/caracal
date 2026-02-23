# @caracal/core — Node.js SDK

> Pre-execution authority enforcement SDK for AI agents.  
> Mirrors the Python `caracal-core` SDK API surface exactly.

## Installation

```bash
npm install @caracal/core
```

## Quick Start

```typescript
import { CaracalClient } from "@caracal/core";

const client = new CaracalClient({ apiKey: "sk_test_123" });

const agents = await client.agents.list();
const mandate = await client.mandates.create({
  agentId: "agent_001",
  allowedOperations: ["read", "write"],
  expiresIn: 3600,
});
```

## License

AGPLv3 — see LICENSE.  
Enterprise extensions (`src/enterprise/`) are proprietary.
