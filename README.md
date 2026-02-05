<div align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="public/caracal_nobg_dark_mode.png">
<source media="(prefers-color-scheme: light)" srcset="/home/raw/Documents/workspace/caracalEcosystem/Caracal/public/caracal_nobg.png">
<img alt="Caracal Logo" src="public/caracal_nobg.png" width="300">
</picture>
</div>

<div align="center">

**The Economic Control Plane for AI Agents**

</div>

<div align="center">

[![License](https://img.shields.io/badge/License-AGPL_3.0-blue?style=for-the-badge&logo=gnu-bash&logoColor=white)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Garudex-Labs/caracal?style=for-the-badge&label=Release&color=orange)](https://github.com/Garudex-Labs/caracal/releases)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue?style=for-the-badge&logo=python&logoColor=white)](pyproject.toml)
[![Repo Size](https://img.shields.io/github/repo-size/Garudex-Labs/caracal?style=for-the-badge&color=green)](https://github.com/Garudex-Labs/caracal)
[![Activity](https://img.shields.io/github/commit-activity/m/Garudex-Labs/caracal?style=for-the-badge&color=blueviolet)](https://github.com/Garudex-Labs/caracal/graphs/commit-activity)
[![Website](https://img.shields.io/badge/Website-garudexlabs.com-333333?style=for-the-badge&logo=google-chrome&logoColor=white)](https://garudexlabs.com)

</div>

---

## Overview

**Caracal** is the infrastructure layer for the Agentic Economy. It serves as a centralized economic control plane that allows developers and enterprises to enforce budgets, meter usage in real-time, and manage secure ledgers for autonomous AI agents.

As agents transition from chat interfaces to autonomous execution, economic safety becomes critical. Caracal ensures agents operate within defined financial and computational boundaries using dynamic access tokens and ephemeral credentials, preventing runaway API costs and unauthorized transactions.

---

## Quickstart

Caracal offers two distinct interfaces depending on your role and requirements.

### 1. Caracal Flow (Default)

**Target:** Operators, FinOps, and Monitoring Teams.

Caracal Flow is the interactive Terminal User Interface (TUI). It provides a visual dashboard for monitoring agent swarms, managing infrastructure, and auditing real-time spend without writing code.

```text
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     ██████╗ █████╗ ██████╗  █████╗  ██████╗ █████╗ ██╗            ║
║    ██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██║            ║
║    ██║     ███████║██████╔╝███████║██║     ███████║██║            ║
║    ██║     ██╔══██║██╔══██╗██╔══██║██║     ██╔══██║██║            ║
║    ╚██████╗██║  ██║██║  ██║██║  ██║╚██████╗██║  ██║███████╗       ║
║     ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝       ║
║                                                                   ║
║                   C A R A C A L  F L O W                          ║
║              Economic Control Plane for AI Agents                 ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝

```

**Launch Dashboard:**

```bash
uv run caracal-flow

```

**Capabilities in Flow:**

* **Visual Metering:** Real-time graphs of token usage and dollar spend.
* **One-Click Infrastructure:** Toggle between local SQLite and production Docker stacks.
* **Policy Management:** GUI-based adjustments for agent budget caps.

---

### 2. Caracal Core (Power Users)

**Target:** Developers, CI/CD Engineers, and System Architects.

Caracal Core provides the high-performance CLI and SDK for deep integration. It is designed for users who require programmatic control, custom scripting, or wish to embed economic safety checks directly into agent loops.

**Installation:**

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
pip install -e .

```

**CLI Commands:**

```bash
# Register a new agent identity with a hard budget cap
caracal agents register --name "researcher-01" --budget 50.00 --zone "dev-cluster"

# Generate a dynamic access token for a specific session
caracal auth token --agent "researcher-01" --ttl 3600

# Audit the ledger for specific transactions
caracal ledger audit --agent "researcher-01" --format json

```

**Advanced Configuration:**
Power users can override default behaviors by modifying `caracal.yaml` or setting environment variables for custom identity providers (IdP) and key management systems (KMS).

---

## Core Capabilities

**Dynamic Identity & Access**
Move beyond static API keys. Caracal issues ephemeral, identity-attested credentials that can be revoked instantly. Authorization happens at the edge where agents interact with their environment.

**Budget Enforcement**
Define hard caps on token usage, dollar spend, and transaction frequency per agent identity. Policies are deterministic and enforced at the gateway level before any cost is incurred.

**Secure Ledger**
An immutable audit trail for every economic decision made by an agent. This system of record allows companies to attribute costs to specific agents, explain outcomes, and ensure compliance.

**Agent-Native Data Model**
Map workloads into logical, ephemeral zones. Spin zones up or down as needed, perfect for dynamic, agent-native workloads that integrate directly into your software development lifecycle.

---

## Infrastructure

Caracal is designed to scale with your agent fleet.

| Environment | Database | Messaging | Cache | Use Case |
| --- | --- | --- | --- | --- |
| **Local** | SQLite | In-Memory | Local Dict | Zero-setup dev, testing, and Caracal Flow default. |
| **Production** | PostgreSQL | Kafka | Redis | High-throughput enterprise deployment. |

**To enable production mode:**

1. Open `caracal-flow`.
2. Navigate to **Settings & Config** > **Infrastructure Setup**.
3. Select **Start All Services** (provisions containers via Docker).

---

## Project Structure

* `caracal/core/`: Business logic for budgeting, identity, and ledger operations.
* `caracal/flow/`: TUI layer for the visual dashboard.
* `caracal/gateway/`: Policy enforcement proxy and middleware.
* `deploy/`: Infrastructure definitions (Docker Compose, Helm).

---

## License

Caracal is open-source software licensed under the **AGPL-3.0**. See the [LICENSE](https://github.com/Garudex-Labs/caracal/blob/main/LICENSE) file for full details.

**Developed by Garudex Labs.**