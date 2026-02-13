---
sidebar_position: 1
title: Introduction to Caracal Core
---

# Introduction to Caracal Core

Caracal Core is an **execution authority enforcement engine** for AI agents. It sits between your agents and the external APIs they consume, ensuring that every request carries a valid, verifiable mandate before it executes.

## Why Caracal Core?

As AI agents become more autonomous, they need enforceable controls to prevent:

- **Unauthorized Actions** -- Agents acting outside their granted authority.
- **Unverifiable Execution** -- No proof that an action was sanctioned.
- **Uncontrolled Delegation** -- Authority spreading without constraint.

Caracal solves these problems by enforcing authority at the **network level**, not relying on agent self-reporting.

## Core Concepts

### Principal

Any entity that participates in the authority system: an AI agent, a human user, or a backend service. Principals are registered with unique identities and can hold policies.

### Mandate

A time-bound, scoped token that grants a principal permission to perform specific actions on specific resources. Mandates are cryptographically signed, verifiable, and revocable.

### Authority Policy

A set of rules governing what mandates can be issued to a principal. Policies define allowed resources, actions, validity periods, and delegation depth.

### Gateway Proxy

All agent traffic flows through the Caracal Gateway, which intercepts requests, validates mandates, and records authority events in real-time.

### Authority Ledger

Every authority event (mandate issued, validated, denied, revoked) is recorded in a Merkle tree-backed ledger, providing cryptographic proof of all decisions.

### Fail-Closed Design

If the authority engine or ledger is unavailable, requests are **denied by default**. No unchecked execution is permitted.

## Next Steps

- [Installation](./installation) -- Set up Caracal Core.
- [Quickstart](./quickstart) -- Deploy in 5 minutes.
