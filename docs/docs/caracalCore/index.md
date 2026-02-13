---
sidebar_position: 1
title: Caracal Core
---

# Caracal Core

Caracal Core is the **network-enforced policy enforcement and metering engine** for AI agents. It provides cryptographic proof of all spending events and real-time budget enforcement.

## What Caracal Core Provides

| Component | Description |
|-----------|-------------|
| **Gateway Proxy** | Intercepts and authorizes all agent API calls at the network level |
| **Policy Engine** | Evaluates spending limits, time windows, and allowlists in real-time |
| **Immutable Ledger** | Records all metering events with Merkle tree integrity proofs |
| **CLI Tools** | Full command-line interface for automation and operations |
| **SDK** | Python client for direct integration into your applications |

## Quick Navigation

### For New Users

Start here to understand and deploy Caracal:

1. **[Introduction](./gettingStarted/introduction)** - Learn the core concepts
2. **[Installation](./gettingStarted/installation)** - Set up your environment
3. **[Quickstart](./gettingStarted/quickstart)** - Deploy in 5 minutes

### For Daily Operations

Guides for day-to-day management:

- **[Agent Commands](./cliReference/agent)** - Register and manage agents
- **[Policy Commands](./cliReference/policy)** - Create and manage budgets
- **[Ledger Commands](./cliReference/ledger)** - Query spending history

### For Advanced Users

Deep dives into specific areas:

- **[Architecture](./concepts/architecture)** - Understand system design
- **[Core vs Flow](./concepts/coreVsFlow)** - When to use each tool
- **[Merkle Commands](./cliReference/merkle)** - Cryptographic integrity verification
- **[Delegation Commands](./cliReference/delegation)** - Parent-child budget sharing

### For Integration

Build Caracal into your applications:

- **[SDK Reference](./apiReference/sdkClient)** - Python SDK documentation
- **[MCP Integration](./apiReference/mcpIntegration)** - Model Context Protocol
- **[MCP Decorators](./apiReference/mcpDecorators)** - Decorator-based integration

### For Production

Deploy to production environments:

- **[Docker Compose](./deployment/dockerCompose)** - Local/development deployment
- **[Kubernetes](./deployment/kubernetes)** - Container orchestration
- **[Production Guide](./deployment/production)** - Scaling and security
- **[Operational Runbook](./deployment/operationalRunbook)** - Day-2 operations

---

## Command-Line Interface

Caracal Core provides a comprehensive CLI for all operations:

```bash
# Global help
caracal --help

# Initialize Caracal
caracal init

# Manage agents
caracal agent register --name my-agent --owner user@example.com
caracal agent list

# Create policies
caracal policy create --agent-id <uuid> --limit 100.00

# Query ledger
caracal ledger query --agent-id <uuid>
caracal ledger summary --agent-id <uuid>

# Database operations
caracal db init-db
caracal db migrate up
caracal db status

# Merkle tree verification
caracal merkle status
caracal merkle verify --full
```

See the [CLI Reference](./cliReference/) for complete documentation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AI AGENT APPLICATION                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                │ HTTP Request
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CARACAL GATEWAY PROXY                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Authenticate │──│ Check Policy │──│ Record Spend │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │    POLICY    │  │    LEDGER    │  │   MERKLE     │
     │    ENGINE    │  │   (Events)   │  │    TREE      │
     └──────────────┘  └──────────────┘  └──────────────┘
              │                 │                 │
              └─────────────────┼─────────────────┘
                                │
                                ▼
                       ┌──────────────┐
                       │  PostgreSQL  │
                       │   Database   │
                       └──────────────┘
```

Learn more in [Architecture](./concepts/architecture).

---

## Key Features

### Network-Level Enforcement

Spending limits are enforced at the network level before requests reach AI providers. Agents cannot bypass budget controls.

### Immutable Audit Trail

Every spending event is recorded in an append-only ledger with Merkle tree integrity proofs. Tampering is cryptographically detectable.

### Real-Time Policy Evaluation

Policies are evaluated in under 100ms, enabling real-time request blocking without significant latency impact.

### Hierarchical Delegation

Parent agents can delegate budget to child agents with constraints. Spending is tracked across the entire hierarchy.

### Rich Analytics

Query spending by agent, time range, operation type, and more. Export data for compliance and cost analysis.

---

## Next Steps

Ready to get started?

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
          Start Now →
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
          Explore →
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
          Learn →
        </Link>
      </div>
    </div>
  </div>
</div>
