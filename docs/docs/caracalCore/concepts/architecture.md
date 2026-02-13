---
sidebar_position: 1
title: Architecture
---

# Caracal Core Architecture

Technical architecture of the Caracal policy enforcement system.

---

## System Overview

```
+------------------------------------------------------------------+
|                        AI AGENT APPLICATIONS                      |
|                                                                   |
|  +--------+   +--------+   +--------+   +--------+   +--------+  |
|  | Agent  |   | Agent  |   | Agent  |   | Agent  |   | Agent  |  |
|  |   1    |   |   2    |   |   3    |   |   4    |   |   5    |  |
|  +---+----+   +---+----+   +---+----+   +---+----+   +---+----+  |
+------+-----------+-----------+-----------+-----------+------------+
       |           |           |           |           |
       +-----------+-----------+-----------+-----------+
                               |
                               | HTTP Requests with Budget Headers
                               v
+------------------------------------------------------------------+
|                     CARACAL GATEWAY PROXY                         |
|                                                                   |
|  1. Authenticate Request                                          |
|  2. Evaluate Budget Policy                                        |
|  3. Record Spending to Ledger                                     |
|  4. Forward Request or Reject                                     |
+------------------------------------------------------------------+
                               |
         +---------------------+---------------------+
         v                     v                     v
+----------------+   +------------------+   +----------------+
|    POLICY      |   |     LEDGER       |   |    MERKLE      |
|    ENGINE      |   |   (Immutable)    |   |     TREE       |
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

## Core Components

| Component | Description |
|-----------|-------------|
| Gateway Proxy | Intercepts AI API requests, enforces policies |
| Policy Engine | Evaluates budget limits and time windows |
| Ledger | Immutable append-only spending log |
| Merkle Tree | Cryptographic integrity verification |
| Agent Registry | Identity management for AI agents |
| Pricebook | Resource pricing configuration |

---

## Agent Registry

Manages AI agent identities and hierarchical relationships.

```
+-----------------------------------+
|          AGENT REGISTRY           |
+-----------------------------------+
|                                   |
|  +---------------------------+    |
|  |     Root Agent            |    |
|  |     (Orchestrator)        |    |
|  +-------------+-------------+    |
|                |                  |
|      +---------+---------+        |
|      |                   |        |
|  +---+---+           +---+---+    |
|  | Child |           | Child |    |
|  |   1   |           |   2   |    |
|  +-------+           +---+---+    |
|                          |        |
|                      +---+---+    |
|                      |Grandch|    |
|                      +-------+    |
+-----------------------------------+
```

| Field | Description |
|-------|-------------|
| agent_id | Unique UUID identifier |
| name | Human-readable name |
| owner | Owner email or identifier |
| parent_agent_id | Parent for hierarchical relationships |
| metadata | Key-value pairs for custom data |

---

## Policy Engine

Evaluates spending limits with support for multiple policies per agent.

### Policy Evaluation Flow

```
                +-------------------+
                |   Check Budget    |
                |     Request       |
                +---------+---------+
                          |
                          v
                +-------------------+
                |   Get Agent       |
                |   Policies        |
                +---------+---------+
                          |
                          v
                +-------------------+
                |  For Each Policy  |<--------+
                +---------+---------+         |
                          |                   |
                          v                   |
                +-------------------+         |
                |  Calculate Time   |         |
                |     Window        |         |
                +---------+---------+         |
                          |                   |
                          v                   |
                +-------------------+         |
                |  Sum Spending     |         |
                |   in Window       |         |
                +---------+---------+         |
                          |                   |
                          v                   |
                +-------------------+         |
                | Spending < Limit? |         |
                +---------+---------+         |
                     |         |              |
                    Yes        No             |
                     |         |              |
                     |    +----v----+         |
                     |    | REJECT  |         |
                     |    +---------+         |
                     v                        |
                +-------------------+         |
                | More Policies?    +---------+
                +---------+---------+
                          |
                          | No more
                          v
                +-------------------+
                |     ALLOW         |
                +-------------------+
```

### Policy Fields

| Field | Type | Description |
|-------|------|-------------|
| policy_id | UUID | Unique identifier |
| agent_id | UUID | Target agent |
| limit_amount | Decimal | Maximum spending |
| currency | String | Currency code |
| time_window | Enum | hourly, daily, weekly, monthly |
| window_type | Enum | calendar, rolling |

---

## Ledger

Append-only immutable log of spending events.

### Event Structure

| Field | Type | Description |
|-------|------|-------------|
| event_id | UUID | Unique identifier |
| agent_id | UUID | Agent that incurred cost |
| timestamp | ISO 8601 | Event timestamp |
| amount | Decimal | Cost amount |
| currency | String | Currency code |
| operation_type | String | Type of operation |
| resource_type | String | Pricebook resource |
| quantity | Decimal | Quantity consumed |
| delegation_chain | Array | Parent agent chain |
| request_id | String | Original request ID |

### Partitioning

```
+------------------------------------------+
|              LEDGER TABLE                |
+------------------------------------------+
|                                          |
|  +------------+                          |
|  | 2024-01    |  (Oldest, archive ready) |
|  +------------+                          |
|  | 2024-02    |                          |
|  +------------+                          |
|  | 2024-03    |  (Current month)         |
|  +------------+                          |
|  | 2024-04    |  (Future partition)      |
|  +------------+                          |
|                                          |
+------------------------------------------+
```

---

## Merkle Tree

Provides cryptographic integrity proofs.

```
                      +-------------+
                      | Merkle Root |
                      |   H(1,2)    |
                      +------+------+
                             |
              +--------------+--------------+
              |                             |
        +-----+-----+                 +-----+-----+
        |  H(A,B)   |                 |  H(C,D)   |
        +-----+-----+                 +-----+-----+
              |                             |
       +------+------+               +------+------+
       |             |               |             |
    +--+--+       +--+--+         +--+--+       +--+--+
    | H(A)|       | H(B)|         | H(C)|       | H(D)|
    +-----+       +-----+         +-----+       +-----+
       ^             ^               ^             ^
       |             |               |             |
    Event A      Event B          Event C      Event D
```

### Properties

| Property | Description |
|----------|-------------|
| Tamper-evident | Any change to historical data is detectable |
| Inclusion proofs | Prove an event exists in O(log n) space |
| Signed roots | Daily root hashes signed with Ed25519 |
| Audit ready | Export proofs for external verification |

---

## Data Flow

### Request Processing

```
Agent Request
     |
     v
+------------------+
| Gateway Proxy    |
+------------------+
     |
     +----> Validate Delegation Token
     |
     +----> Check Budget (Policy Engine)
     |         |
     |         +----> Query Ledger for current spending
     |         |
     |         +----> Compare against policy limits
     |
     +----> If ALLOWED: Forward to AI Provider
     |
     +----> Record Event (Ledger)
     |         |
     |         +----> Append to ledger
     |         |
     |         +----> Update Merkle tree
     |
     v
Response to Agent
```

### Event Recording

```
Metering Event
     |
     v
+------------------+
| Event Validation |
+------------------+
     |
     v
+------------------+
| Calculate Cost   |
| (Pricebook)      |
+------------------+
     |
     v
+------------------+
| Append to Ledger |
+------------------+
     |
     v
+------------------+
| Update Merkle    |
+------------------+
     |
     v
+------------------+
| Publish to Kafka |
+------------------+
```

---

## Security Model

### Fail-Closed Semantics

| Scenario | Behavior |
|----------|----------|
| Database unavailable | Deny all requests |
| Policy check fails | Deny request |
| Event recording fails | Raise exception |
| Merkle verification fails | Alert and deny |

### Authentication

| Method | Use Case |
|--------|----------|
| Agent ID | Identify the agent |
| Delegation Token | Prove budget authority |
| API Key | Gateway authentication |

### Audit Trail

- All events are immutable
- Merkle proofs are exportable
- Root hashes are signed daily
- Full history is preserved

---

## Enterprise Integration

Caracal Core is designed to work seamlessly with **Caracal Enterprise Edition**.

- **Policy Sync**: Core instances can legally pull policy updates from the Enterprise Control Plane.
- **Telemetry**: Spending logs and audit trails are pushed to Enterprise for centralized monitoring.
- **Fail-Safe**: If Enterprise connectivity is lost, Core continues to enforce cached policies (Fail-Closed if cache expires).

---

## Deployment Patterns

### Single Node

```
+----------------------------------+
|         Single Server            |
|                                  |
|  +--------+  +--------+          |
|  | Gateway|  |  CLI   |          |
|  +----+---+  +----+---+          |
|       |           |              |
|       +-----+-----+              |
|             |                    |
|       +-----+-----+              |
|       | PostgreSQL|              |
|       +-----------+              |
+----------------------------------+
```

### High Availability

```
+------------------------------------------+
|            Load Balancer                 |
+--------------------+---------------------+
                     |
         +-----------+-----------+
         |                       |
+--------v--------+    +--------v--------+
|    Gateway 1    |    |    Gateway 2    |
+-----------------+    +-----------------+
         |                       |
         +-----------+-----------+
                     |
         +-----------+-----------+
         |           |           |
+--------v--+ +------v----+ +----v------+
| Primary   | | Replica 1 | | Replica 2 |
| PostgreSQL| | (read)    | | (read)    |
+-----------+ +-----------+ +-----------+
```

---

## See Also

- [Core vs Flow](/caracalCore/concepts/coreVsFlow) - Product comparison
- [Deployment](/caracalCore/deployment/dockerCompose) - Deployment guides
- [CLI Reference](/caracalCore/cliReference/) - Command documentation
