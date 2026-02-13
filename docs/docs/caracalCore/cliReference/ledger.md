---
sidebar_position: 4
title: Ledger Commands
---

# Ledger Commands

The `ledger` command group queries the immutable authority event ledger.

```
caracal ledger COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`query`](#query) | Query authority events |
| [`summary`](#summary) | Get principal activity summary |
| [`delegation-chain`](#delegation-chain) | Trace delegation for an event |
| [`list-partitions`](#list-partitions) | List ledger partitions |
| [`create-partitions`](#create-partitions) | Create new partitions |
| [`archive-partitions`](#archive-partitions) | Archive old partitions |

---

## Ledger Properties

| Property | Description |
|----------|-------------|
| Append-only | Events can only be added, never modified |
| Immutable | Historical records cannot be changed |
| Merkle-backed | Cryptographic integrity proofs |
| Partitioned | Monthly partitions for performance |

---

## query

Query authority events with filters.

```
caracal ledger query [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--agent-id` | `-a` | - | Filter by principal ID |
| `--start-time` | `-s` | - | Start time (ISO 8601) |
| `--end-time` | `-e` | - | End time (ISO 8601) |
| `--event-type` | `-t` | - | Filter by event type (issued, validated, denied, revoked) |
| `--limit` | `-n` | 100 | Maximum results |
| `--offset` | | 0 | Skip this many results |
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>Query by principal</summary>

```bash
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --limit 10
```

**Output:**
```
Event ID                              Timestamp              Type        Resource              Decision
-----------------------------------------------------------------------------------------------------------
evt-001-aaaa-bbbb-cccc                2024-01-15T14:30:45Z   validated   api:external/openai   allowed
evt-002-aaaa-bbbb-cccc                2024-01-15T14:28:12Z   denied      api:external/stripe   no mandate
evt-003-aaaa-bbbb-cccc                2024-01-15T14:25:00Z   issued      api:external/*        -

Showing 3 of 1,234 events
```

</details>

<details>
<summary>Query denied events</summary>

```bash
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --event-type denied
```

</details>

<details>
<summary>Query by time range</summary>

```bash
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --start-time 2024-01-15T00:00:00Z \
  --end-time 2024-01-15T23:59:59Z
```

</details>

---

## summary

Get authority event summary for a principal.

```
caracal ledger summary [OPTIONS]
```

### Options

| Option | Short | Required | Default | Description |
|--------|-------|:--------:|---------|-------------|
| `--agent-id` | `-a` | Yes | - | Principal ID |
| `--time-window` | `-w` | No | daily | Summary window |
| `--format` | `-f` | No | table | Output format |

<details>
<summary>Daily summary</summary>

```bash
caracal ledger summary --agent-id 550e8400-e29b-41d4-a716-446655440000
```

**Output:**
```
Principal Activity Summary
==========================

Principal ID:   550e8400-e29b-41d4-a716-446655440000
Principal Name: orchestrator
Time Window:    daily
Period:         2024-01-15T00:00:00Z to 2024-01-15T23:59:59Z

Authority Events
----------------
Issued:     12
Validated:  156
Denied:     3
Revoked:    1

Breakdown by Resource
---------------------
Resource                 Validated   Denied    Actions
---------------------------------------------------------
api:external/openai      120         0         execute
api:external/anthropic   30          1         execute
db:analytics/*           6           2         read, write
```

</details>

---

## delegation-chain

Trace the delegation chain for an event.

```
caracal ledger delegation-chain [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--event-id` | `-e` | Yes | Event ID to trace |
| `--format` | `-f` | No | Output format |

<details>
<summary>Trace delegation chain</summary>

```bash
caracal ledger delegation-chain --event-id evt-001-aaaa-bbbb-cccc
```

**Output:**
```
Delegation Chain for Event: evt-001-aaaa-bbbb-cccc
==================================================

Event Details
-------------
Event ID:     evt-001-aaaa-bbbb-cccc
Type:         validated
Resource:     api:external/openai
Action:       execute
Timestamp:    2024-01-15T14:30:45Z

Delegation Chain
----------------

  +-------------------+
  |   orchestrator    |  Policy: api:external/*
  | (Root Principal)  |  Delegation depth: 2
  +---------+---------+
            |
            | Delegated: api:external/openai (execute)
            v
  +-------------------+
  |     worker-1      |  Mandate: mdt-001-aaaa
  | (Child Principal) |  Valid until: 2024-01-15T23:59:59Z
  +---------+---------+
            |
            | Executed action
            v
  +-------------------+
  |    THIS EVENT     |
  |   allowed         |
  +-------------------+
```

</details>

---

## list-partitions

List ledger table partitions.

```
caracal ledger list-partitions [OPTIONS]
```

> Note: Requires database backend.

<details>
<summary>List all partitions</summary>

```bash
caracal ledger list-partitions
```

**Output:**
```
Ledger Partitions
=================

Partition Name              Range Start         Range End           Rows        Size
---------------------------------------------------------------------------------------
ledger_events_2024_01       2024-01-01          2024-02-01          1,234,567   156 MB
ledger_events_2024_02       2024-02-01          2024-03-01          987,654     124 MB
ledger_events_2024_03       2024-03-01          2024-04-01          (current)   45 MB

Total: 3 partitions, 2,222,221 rows, 325 MB
```

</details>

---

## create-partitions

Create new partitions for future months.

```
caracal ledger create-partitions [OPTIONS]
```

> Note: Requires database backend.

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--months` | `-m` | 3 | Number of months to create |

---

## archive-partitions

Archive old partitions.

```
caracal ledger archive-partitions [OPTIONS]
```

> Note: Requires database backend.

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--before` | `-b` | Yes | Archive partitions before this date |
| `--output` | `-o` | No | Output directory for archives |
| `--delete` | | No | Delete after archiving |

---

## Event Structure

| Field | Type | Description |
|-------|------|-------------|
| event_id | UUID | Unique event identifier |
| principal_id | UUID | Principal involved |
| event_type | String | issued, validated, denied, revoked |
| mandate_id | UUID | Associated mandate |
| timestamp | ISO 8601 | When the event occurred |
| requested_action | String | Action requested |
| requested_resource | String | Resource requested |
| decision | String | allowed or denied |
| denial_reason | String | Reason for denial (if applicable) |
| delegation_chain | Array | Parent principals in delegation |
| metadata | Object | Additional context |

---

## See Also

- [Merkle Commands](./merkle) -- Verify ledger integrity
- [Policy Commands](./policy) -- Authority policies
- [Delegation Commands](./delegation) -- Delegation management
