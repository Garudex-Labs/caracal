---
sidebar_position: 1
title: Architecture
---

# Caracal Core Architecture

Technical architecture of the Caracal authority enforcement system.

---

## System Overview

```
+------------------------------------------------------------------+
|                        AI AGENT APPLICATIONS                      |
|                                                                   |
|  +--------+   +--------+   +--------+   +--------+   +--------+  |
|  |Princip.|   |Princip.|   |Princip.|   |Princip.|   |Princip.|  |
|  |   1    |   |   2    |   |   3    |   |   4    |   |   5    |  |
|  +---+----+   +---+----+   +---+----+   +---+----+   +---+----+  |
+------+-----------+-----------+-----------+-----------+------------+
       |           |           |           |           |
       +-----------+-----------+-----------+-----------+
                               |
                               | HTTP Requests with Mandate Headers
                               v
+------------------------------------------------------------------+
|                     CARACAL GATEWAY PROXY                         |
|                                                                   |
|  1. Authenticate Principal                                        |
|  2. Validate Mandate (scope, expiry, signature, revocation)       |
|  3. Record Authority Event in Ledger                              |
|  4. Forward Request or Deny                                       |
+------------------------------------------------------------------+
                               |
         +---------------------+---------------------+
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

## Core Components

| Component | Description |
|-----------|-------------|
| Gateway Proxy | Intercepts agent API requests, validates mandates |
| Authority Policy Engine | Evaluates whether mandates can be issued to principals |
| Authority Ledger | Immutable append-only log of all authority events |
| Merkle Tree | Cryptographic integrity verification for the ledger |
| Principal Registry | Identity management for AI agents, users, and services |
| Delegation Engine | Manages scoped authority transfer between principals |

---

## Principal Registry

Manages principal identities and hierarchical relationships.

```
+-----------------------------------+
|       PRINCIPAL REGISTRY          |
+-----------------------------------+
|                                   |
|  +---------------------------+    |
|  |    Root Principal         |    |
|  |    (Orchestrator)         |    |
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
| principal_id | Unique UUID identifier |
| name | Human-readable name |
| owner | Owner email or identifier |
| parent_id | Parent for hierarchical relationships |
| type | agent, user, or service |
| metadata | Key-value pairs for custom data |

---

## Authority Policy Engine

Evaluates whether a mandate can be issued or validated for a given principal.

### Mandate Validation Flow

```
                +-------------------+
                |  Validate Mandate |
                |     Request       |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Check Signature   |
                | (Cryptographic)   |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Check Expiration  |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Check Revocation  |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Validate Action   |
                | Scope             |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Validate Resource |
                | Scope             |
                +---------+---------+
                     |         |
                    Yes        No
                     |         |
                     |    +----v----+
                     |    | DENY    |
                     |    +---------+
                     v
                +-------------------+
                | Check Delegation  |
                | Chain             |
                +---------+---------+
                     |         |
                   Valid     Invalid
                     |         |
                     v    +----v----+
                +--------+| DENY    |
                | ALLOW  |+---------+
                +--------+
```

### Policy Fields

| Field | Type | Description |
|-------|------|-------------|
| policy_id | UUID | Unique identifier |
| principal_id | UUID | Target principal |
| allowed_resources | List[str] | Resource patterns (supports wildcards) |
| allowed_actions | List[str] | Permitted actions (read, write, execute) |
| max_validity | int | Maximum mandate validity in seconds |
| delegation_depth | int | Maximum delegation chain depth |

---

## Authority Ledger

Append-only immutable log of all authority events.

### Event Structure

| Field | Type | Description |
|-------|------|-------------|
| event_id | UUID | Unique identifier |
| event_type | String | issued, validated, denied, revoked |
| principal_id | UUID | Principal involved |
| mandate_id | UUID | Associated mandate |
| timestamp | ISO 8601 | Event timestamp |
| requested_action | String | Action requested |
| requested_resource | String | Resource requested |
| decision | String | allowed or denied |
| denial_reason | String | Reason for denial (if applicable) |
| delegation_chain | Array | Parent mandate chain |

<details>
<summary>Ledger partitioning</summary>

```
+------------------------------------------+
|           AUTHORITY LEDGER               |
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

</details>

---

## Merkle Tree

Provides cryptographic integrity proofs for the authority ledger.

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
     +----> Authenticate Principal
     |
     +----> Validate Mandate
     |         |
     |         +----> Check signature, expiry, revocation
     |         |
     |         +----> Validate action and resource scope
     |         |
     |         +----> Verify delegation chain
     |
     +----> If ALLOWED: Forward to target API
     |
     +----> Record Authority Event
     |         |
     |         +----> Append to ledger
     |         |
     |         +----> Update Merkle tree
     |
     v
Response to Agent
```

---

## Security Model

### Fail-Closed Semantics

| Scenario | Behavior |
|----------|----------|
| Database unavailable | Deny all requests |
| Mandate validation fails | Deny request |
| Event recording fails | Raise exception |
| Merkle verification fails | Alert and deny |

### Authentication

| Method | Use Case |
|--------|----------|
| Principal ID | Identify the entity |
| Mandate Token | Prove execution authority |
| API Key | Gateway authentication |

### Audit Trail

- All authority events are immutable
- Merkle proofs are exportable
- Root hashes are signed daily
- Full history is preserved

---

## Enterprise Integration

Caracal Core works with **Caracal Enterprise Edition** for centralized management.

- **Policy Sync** -- Core instances pull policy updates from the Enterprise Control Plane.
- **Telemetry** -- Authority events are pushed to Enterprise for centralized monitoring.
- **Fail-Safe** -- If Enterprise connectivity is lost, Core continues to enforce cached policies (fail-closed if cache expires).

---

## Deployment Patterns

<details>
<summary>Single node</summary>

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

</details>

<details>
<summary>High availability</summary>

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

</details>

---

## See Also

- [Core vs Flow](/caracalCore/concepts/coreVsFlow) -- Product comparison
- [Deployment](/caracalCore/deployment/dockerCompose) -- Deployment guides
- [CLI Reference](/caracalCore/cliReference/) -- Command documentation
