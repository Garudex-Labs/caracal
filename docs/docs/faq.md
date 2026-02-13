---
sidebar_position: 1
title: FAQ
---

# Frequently Asked Questions

---

## General

<details>
<summary>What is Caracal?</summary>

Caracal is an **execution authority enforcement layer** for AI agents. It ensures every agent action is explicitly authorized via a mandate, validated at the network level, and recorded in an immutable audit trail. It is not a billing system, API gateway, or monitoring tool.

</details>

<details>
<summary>What problem does Caracal solve?</summary>

As AI agents gain autonomy, they can interact with external APIs, databases, and services. Without enforceable controls, agents can act outside their intended scope. Caracal enforces the principle: **no mandate, no execution**. Every action requires a valid, verifiable, time-bound mandate.

</details>

<details>
<summary>How is Caracal different from an API gateway?</summary>

API gateways handle routing, rate limiting, and load balancing. Caracal handles **authority enforcement** -- verifying that a principal holds a valid mandate for a specific action on a specific resource before the request is forwarded. Caracal can work alongside an API gateway.

</details>

---

## Architecture

<details>
<summary>What is a principal?</summary>

A principal is any entity in the Caracal system that can hold authority: an AI agent, a human user, or a backend service. Principals are registered with unique IDs and can have hierarchical relationships (parent-child).

</details>

<details>
<summary>What is a mandate?</summary>

A mandate is a time-bound, scoped token that grants a principal permission to perform specific actions on specific resources. Mandates are cryptographically signed, revocable, and verifiable in O(1) time.

</details>

<details>
<summary>What happens if Caracal is unavailable?</summary>

Caracal is **fail-closed**. If the authority engine, database, or ledger is unavailable, all requests are denied. No unchecked execution is permitted.

</details>

<details>
<summary>How does delegation work?</summary>

A principal with a valid mandate can delegate a subset of their authority to another principal. The delegated mandate cannot exceed the scope of the parent mandate. Delegation chains are validated end-to-end.

</details>

---

## Products

<details>
<summary>What is the difference between Caracal Core and Caracal Enterprise?</summary>

| | Caracal Core | Caracal Enterprise |
|---|---|---|
| Deployment | Self-hosted | Self-hosted or managed |
| Management | CLI, SDK | Web Dashboard, API |
| Multi-tenancy | No | Yes (workspaces) |
| Centralized sync | No | Yes |
| Analytics | No | Yes |
| SSO/RBAC | No | Yes |

Caracal Core is the enforcement engine. Enterprise adds centralized management, analytics, and multi-team support.

</details>

<details>
<summary>Is Caracal open-source?</summary>

Caracal Core is open-source under the AGPL-3.0 license. Caracal Enterprise is available under a commercial license. See the [GitHub repository](https://github.com/Garudex-Labs/Caracal) for details.

</details>

<details>
<summary>What is Caracal Flow?</summary>

Caracal Flow is a terminal-based UI (TUI) for managing Caracal interactively. It provides guided wizards and visual menus for day-to-day operations without needing to memorize CLI commands.

</details>

---

## Deployment

<details>
<summary>What are the system requirements?</summary>

| Component | Requirement |
|-----------|-------------|
| Python | 3.10+ |
| Database | PostgreSQL 13+ |
| Docker | 20.10+ (for containerized deployment) |
| RAM | 2GB minimum |

</details>

<details>
<summary>Can I run Caracal without Docker?</summary>

Yes. Install via pip: `pip install caracal-core`. You need a PostgreSQL database and can use `caracal db init-db` to initialize the schema.

</details>

---

## Support

| Resource | Link |
|----------|------|
| GitHub Issues | [Report a Bug](https://github.com/Garudex-Labs/Caracal/issues) |
| Open Source Support | [Book a Call](https://cal.com/rawx18/open-source) |
| Enterprise Sales | [Book a Call](https://cal.com/rawx18/caracal-enterprise-sales) |
| Discord | [Join Community](https://discord.gg/d32UBmsK7A) |
