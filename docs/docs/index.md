---
slug: /
sidebar_position: 1
title: Welcome to Caracal
---

# Caracal

<p align="center">
  <img src="/img/caracal_inverted.png" width="200" alt="Caracal Logo" className="logo-dark" />
  <img src="/img/caracal.png" width="200" alt="Caracal Logo" className="logo-light" />
</p>

**Execution authority enforcement for AI agents.**

Caracal ensures every AI agent action is explicitly authorized, cryptographically verifiable, and fully auditable -- before it executes.

## Products

<div className="row">
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>Caracal Core</h3>
      </div>
      <div className="card__body">
        <p>The authority enforcement engine. Gateway, SDK, CLI, and audit ledger.</p>
      </div>
      <div className="card__footer">
        <a className="button button--primary button--block" href="/caracalCore">Get Started</a>
      </div>
    </div>
  </div>
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>Caracal Flow</h3>
      </div>
      <div className="card__body">
        <p>Terminal UI for managing Caracal. Configure principals, policies, and mandates interactively.</p>
      </div>
      <div className="card__footer">
        <a className="button button--secondary button--block" href="/caracalFlow">Explore</a>
      </div>
    </div>
  </div>
  <div className="col col--4">
    <div className="card">
      <div className="card__header">
        <h3>Caracal Enterprise</h3>
      </div>
      <div className="card__body">
        <p>Centralized control plane for multi-team authority management, compliance, and analytics.</p>
      </div>
      <div className="card__footer">
        <a className="button button--secondary button--block" href="/caracalEnterprise/gettingStarted/">Explore</a>
      </div>
    </div>
  </div>
</div>

---

## What is Authority Enforcement?

Caracal is not a billing system or an API gateway. It is an **authority layer** that answers one question before any AI agent acts:

> Does this agent have explicit, valid, and verifiable permission to perform this action on this resource, right now?

| Concept | Description |
|---------|-------------|
| **Principal** | Any entity (AI agent, user, service) that can hold authority |
| **Mandate** | A time-bound, scoped token granting permission to act |
| **Policy** | Rules governing what mandates can be issued to a principal |
| **Delegation** | Scoped transfer of authority from one principal to another |
| **Intent** | Declared purpose attached to a mandate request |
| **Fail-Closed** | If authority cannot be verified, the action is denied |

---

## Architecture Overview

```
+------------------------------------------------------------------+
|                       AI AGENT APPLICATIONS                      |
+------------------------------------------------------------------+
                               |
                               | HTTP Requests
                               v
+------------------------------------------------------------------+
|                     CARACAL GATEWAY PROXY                        |
|                                                                  |
|  +----------------+  +----------------+  +------------------+    |
|  | Authenticate   |->| Validate       |->| Record Authority |    |
|  | Principal      |  | Mandate        |  | Event            |    |
|  +----------------+  +----------------+  +------------------+    |
+------------------------------------------------------------------+
                               |
         +---------------------+---------------------+
         |                     |                     |
         v                     v                     v
+----------------+   +------------------+   +----------------+
|   AUTHORITY    |   |   AUTHORITY      |   |    MERKLE      |
|    POLICY      |   |    LEDGER        |   |     TREE       |
+----------------+   +------------------+   +----------------+
         |                     |                     |
         +---------------------+---------------------+
                               |
                               v
                     +------------------+
                     |    PostgreSQL    |
                     +------------------+
```

---

## CLI Quick Reference

| Task | Command |
|------|---------:|
| Initialize Caracal | `caracal init` |
| Register principal | `caracal agent register --name NAME --owner OWNER` |
| List principals | `caracal agent list` |
| Create policy | `caracal policy create --agent-id ID --resources "api:*" --actions "read"` |
| Query ledger | `caracal ledger query --agent-id ID` |
| Verify integrity | `caracal merkle verify` |

See [CLI Reference](/caracalCore/cliReference/) for complete documentation.

---

## SDK Quick Start

```python
from caracal.sdk import AuthorityClient

client = AuthorityClient(
    base_url="https://your-caracal-instance.example.com",
    api_key="your-api-key"
)

# Request a mandate before performing an action
mandate = client.request_mandate(
    issuer_id="<issuer-principal-id>",
    subject_id="<subject-principal-id>",
    resource_scope=["api:external/*"],
    action_scope=["read"],
    validity_seconds=3600
)

# Validate mandate before execution
validation = client.validate_mandate(
    mandate_id=mandate["mandate_id"],
    requested_action="read",
    requested_resource="api:external/data"
)

if validation["allowed"]:
    result = call_external_api()
```

See [SDK Reference](/caracalCore/apiReference/sdkClient) for complete documentation.

---

## Quick Links

| Category | Links |
|----------|-------|
| Getting Started | [Installation](/caracalCore/gettingStarted/installation) - [Quickstart](/caracalCore/gettingStarted/quickstart) |
| CLI Reference | [Commands](/caracalCore/cliReference/) - [Agent](/caracalCore/cliReference/agent) - [Policy](/caracalCore/cliReference/policy) |
| API Reference | [SDK](/caracalCore/apiReference/sdkClient) - [MCP](/caracalCore/apiReference/mcpIntegration) |
| Enterprise | [Getting Started](/caracalEnterprise/gettingStarted/) - [Using Enterprise](/caracalEnterprise/guides/usage) |
| Development | [Contributing](/development/contributing) - [FAQ](/faq) |

---

## Community and Support

| Resource | Link |
|----------|------|
| GitHub | [Garudex-Labs/Caracal](https://github.com/Garudex-Labs/Caracal) |
| Discord | [Join Community](https://discord.gg/d32UBmsK7A) |
| Open Source Support | [Book a Call](https://cal.com/rawx18/open-source) |
| Enterprise Sales | [Book a Call](https://cal.com/rawx18/caracal-enterprise-sales) |
