---
sidebar_position: 1
title: Caracal Core
---

# Caracal Core

Caracal Core is the **execution authority enforcement engine** for AI agents. It validates mandates, enforces policies, and records every authority decision in a cryptographically verifiable ledger.

## Components

| Component | Description |
|-----------|-------------|
| **Gateway Proxy** | Intercepts agent requests and validates mandates at the network level |
| **Authority Policy Engine** | Evaluates whether mandates can be issued based on principal policies |
| **Authority Ledger** | Immutable, Merkle tree-backed log of all authority events |
| **CLI Tools** | Command-line interface for operations and automation |
| **SDK** | Python client for direct authority integration |

---

## Quick Navigation

### Getting Started

1. **[Introduction](./gettingStarted/introduction)** -- Core concepts
2. **[Installation](./gettingStarted/installation)** -- Set up your environment
3. **[Quickstart](./gettingStarted/quickstart)** -- Deploy in 5 minutes

### Operations

- **[CLI Reference](./cliReference/)** -- Full command documentation
- **[Agent Commands](./cliReference/agent)** -- Register and manage principals
- **[Policy Commands](./cliReference/policy)** -- Create authority policies
- **[Ledger Commands](./cliReference/ledger)** -- Query authority events

### Advanced

- **[Architecture](./concepts/architecture)** -- System design
- **[Core vs Flow](./concepts/coreVsFlow)** -- When to use each tool
- **[Merkle Commands](./cliReference/merkle)** -- Cryptographic integrity verification
- **[Delegation Commands](./cliReference/delegation)** -- Authority delegation

### Integration

- **[SDK Reference](./apiReference/sdkClient)** -- Python SDK
- **[MCP Integration](./apiReference/mcpIntegration)** -- Model Context Protocol

### Deployment

- **[Docker Compose](./deployment/dockerCompose)** -- Local/development
- **[Kubernetes](./deployment/kubernetes)** -- Container orchestration
- **[Production Guide](./deployment/production)** -- Scaling and security

---

## Architecture Overview

```
+-----------------------------------------------------------------+
|                     AI AGENT APPLICATION                         |
+-------------------------------+---------------------------------+
                                |
                                | HTTP Request
                                v
+-----------------------------------------------------------------+
|                    CARACAL GATEWAY PROXY                         |
|  +--------------+  +----------------+  +--------------------+   |
|  | Authenticate |--| Validate       |--| Record Authority   |   |
|  | Principal    |  | Mandate        |  | Event              |   |
|  +--------------+  +----------------+  +--------------------+   |
+-------------------------------+---------------------------------+
                                |
              +-----------------+-----------------+
              v                 v                 v
     +--------------+  +---------------+  +--------------+
     |  AUTHORITY   |  |  AUTHORITY    |  |   MERKLE     |
     |   POLICY     |  |   LEDGER     |  |    TREE      |
     +--------------+  +---------------+  +--------------+
              |                 |                 |
              +-----------------+-----------------+
                                |
                                v
                       +--------------+
                       |  PostgreSQL  |
                       +--------------+
```

---

## Key Capabilities

### Network-Level Enforcement

The Gateway intercepts all agent traffic. Mandates are validated **before** requests reach external APIs. Agents cannot bypass authority controls.

### Immutable Audit Trail

Every authority event (issued, validated, denied, revoked) is recorded in an append-only ledger with Merkle tree integrity proofs.

### Fail-Closed Design

If the authority engine or ledger is unavailable, all requests are **denied by default**. No unchecked execution.

### Hierarchical Delegation

Principals can delegate scoped authority to other principals. Delegation chains are validated end-to-end.

---

## Next Steps

import Link from '@docusaurus/Link';

<div className="row">
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>Quickstart</h3>
      </div>
      <div className="card__body">
        Get Caracal running in 5 minutes
      </div>
      <div className="card__footer">
        <Link className="button button--primary button--block" to="./gettingStarted/quickstart">
          Start Now
        </Link>
      </div>
    </div>
  </div>
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>CLI Reference</h3>
      </div>
      <div className="card__body">
        Complete command documentation
      </div>
      <div className="card__footer">
        <Link className="button button--secondary button--block" to="./cliReference/">
          Explore
        </Link>
      </div>
    </div>
  </div>
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>SDK</h3>
      </div>
      <div className="card__body">
        Python integration guide
      </div>
      <div className="card__footer">
        <Link className="button button--secondary button--block" to="./apiReference/sdkClient">
          Learn
        </Link>
      </div>
    </div>
  </div>
</div>
