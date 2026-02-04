---
sidebar_position: 1
title: Introduction to Caracal Core
---

# Introduction to Caracal Core

Caracal Core is a **network-enforced policy enforcement and metering engine** designed specifically for AI agents. It sits between your agents and the external APIs they consume, ensuring that every request is authorized, metered, and auditable.

## Why Caracal Core?

As AI agents become more autonomous, they need robust controls to prevent:

- **Runaway Spending**: Agents making unlimited API calls.
- **Policy Violations**: Agents accessing unauthorized resources.
- **Unaccountable Actions**: Lack of audit trail for agent behavior.

Caracal Core solves these problems by enforcing policies at the **network level**, not relying on agent self-reporting.

## Core Concepts

### Gateway Proxy
All agent traffic flows through the Caracal Gateway, which intercepts requests, evaluates policies, and meters usage in real-time.

### Policy Engine
Define spending limits, time windows (daily, weekly, monthly), and resource allowlists. Policies are evaluated before every request.

### Immutable Ledger
Every metering event is recorded in a Merkle tree-backed ledger, providing cryptographic proof of all spending.

### Fail-Closed Design
If the policy engine or ledger is unavailable, requests are **denied by default**, preventing unchecked spending.

## Next Steps

- [Installation](./installation): Set up Caracal Core.
- [Quickstart](./quickstart): Deploy in 5 minutes.
