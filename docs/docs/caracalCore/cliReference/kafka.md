---
sidebar_position: 10
title: Kafka Commands
---

# Kafka Commands

The `kafka` command group manages Kafka event streaming.

```
caracal kafka COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`status`](#status) | Check Kafka connection status |
| [`topics`](#topics) | List Kafka topics |
| [`consumers`](#consumers) | List consumer groups |

---

## Kafka Topics

| Topic | Description |
|-------|-------------|
| `caracal.events` | Authority events stream |
| `caracal.dlq` | Dead letter queue |
| `caracal.snapshots` | Snapshot notifications |

---

## status

Check Kafka connection status.

```
caracal kafka status [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>Check Status</summary>

```bash
caracal kafka status
```

**Output:**
```
Kafka Status
============

Connection
----------
  Bootstrap Servers: localhost:9092
  Status:            [OK] Connected
  Latency:           5.2ms

Cluster
-------
  Broker Count:      3
  Controller:        broker-1
  Version:           3.6.0

Topics
------
  caracal.events:    12 partitions, RF=3
  caracal.dlq:       3 partitions, RF=3
  caracal.snapshots: 1 partition, RF=3

Consumer Groups
---------------
  caracal-ledger:    [OK] Active (lag: 0)
  caracal-merkle:    [OK] Active (lag: 12)
  caracal-replay:    [OK] Idle
```

</details>

---

## topics

List Kafka topics.

```
caracal kafka topics [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--pattern` | `-p` | caracal.* | Topic name pattern |
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>List Topics</summary>

```bash
caracal kafka topics
```

**Output:**
```
Kafka Topics
============

Topic                 Partitions    Replication    Messages    Size
----------------------------------------------------------------------
caracal.events        12            3              15,234,567  2.3 GB
caracal.dlq           3             3              45          128 KB
caracal.snapshots     1             3              365         45 MB

Total: 3 topics
```

</details>

<details>
<summary>JSON Output</summary>

```bash
caracal kafka topics --format json
```

**Output:**
```json
[
  {
    "name": "caracal.events",
    "partitions": 12,
    "replication_factor": 3,
    "message_count": 15234567,
    "size_bytes": 2469606195
  },
  {
    "name": "caracal.dlq",
    "partitions": 3,
    "replication_factor": 3,
    "message_count": 45,
    "size_bytes": 131072
  }
]
```

</details>

---

## consumers

List consumer groups.

```
caracal kafka consumers [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--group` | `-g` | - | Filter by group name |
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>List Consumer Groups</summary>

```bash
caracal kafka consumers
```

**Output:**
```
Consumer Groups
===============

Group              State     Members    Lag      Topics
----------------------------------------------------------
caracal-ledger     Active    3          0        caracal.events
caracal-merkle     Active    1          12       caracal.events
caracal-replay     Idle      0          0        caracal.events

Total: 3 consumer groups
```

</details>

<details>
<summary>Get Group Details</summary>

```bash
caracal kafka consumers --group caracal-ledger
```

**Output:**
```
Consumer Group: caracal-ledger
==============================

State:    Active
Members:  3

Member ID                              Host            Partitions
-------------------------------------------------------------------
ledger-1-abc123                        10.0.0.1        0,1,2,3
ledger-2-def456                        10.0.0.2        4,5,6,7
ledger-3-ghi789                        10.0.0.3        8,9,10,11

Partition Offsets
-----------------
Partition    Committed    Latest    Lag
------------------------------------------
0            1234567      1234567   0
1            1234568      1234568   0
...
11           1234579      1234579   0

Total Lag: 0
```

</details>

---

## Configuration

### Configuration File

```yaml
kafka:
  bootstrap_servers:
    - localhost:9092
  security_protocol: SASL_SSL
  sasl_mechanism: PLAIN
  sasl_username: "${KAFKA_USERNAME}"
  sasl_password: "${KAFKA_PASSWORD}"
  
  producer:
    acks: all
    retries: 3
    batch_size: 16384
    linger_ms: 5
    
  consumer:
    group_id: caracal
    auto_offset_reset: earliest
    enable_auto_commit: false
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KAFKA_BOOTSTRAP_SERVERS` | Comma-separated broker list |
| `KAFKA_USERNAME` | SASL username |
| `KAFKA_PASSWORD` | SASL password |

---

## See Also

- [Database Commands](./database) - Database management
- [Ledger Commands](./ledger) - Query events
