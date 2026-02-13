---
sidebar_position: 6
title: Merkle Commands
---

# Merkle Commands

The `merkle` command group manages cryptographic integrity proofs for the ledger.

```
caracal merkle COMMAND [OPTIONS]
```

---

## Overview

Caracal uses a Merkle tree to provide tamper-evident records of authority events.

```
                      +-------------+
                      | Merkle Root |  <-- Current state hash
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
    |  A  |       |  B  |         |  C  |       |  D  |
    +-----+       +-----+         +-----+       +-----+
       ^             ^               ^             ^
       |             |               |             |
    Event 1      Event 2          Event 3      Event 4
```

### Properties

| Property | Description |
|----------|-------------|
| Immutability proof | Any modification to historical records is detectable |
| Inclusion proofs | Prove a specific event exists in the ledger |
| Audit trail | Cryptographic chain of custody for compliance |
| Signed roots | Daily root hashes signed with Ed25519 key |

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`status`](#status) | View current Merkle tree status |
| [`proof`](#proof) | Generate inclusion proof for an event |
| [`verify`](#verify) | Verify ledger integrity |
| [`root`](#root) | Get current or historical Merkle root |
| [`export-proofs`](#export-proofs) | Export proofs for audit |

---

## status

View current Merkle tree status.

```
caracal merkle status [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>Check Status</summary>

```bash
caracal merkle status
```

**Output:**
```
Merkle Tree Status
==================

Current State
-------------
  Root Hash:        a7b3c8d1e5f2... (SHA-256)
  Tree Height:      24
  Total Leaves:     16,777,216
  Last Updated:     2024-01-15T14:32:00Z

Signing Key
-----------
  Key ID:           key-001-aaaa-bbbb
  Algorithm:        Ed25519
  Created:          2024-01-01T00:00:00Z
  Expires:          2025-01-01T00:00:00Z
  Status:           [OK] Active

Integrity
---------
  Last Verification: 2024-01-15T00:00:00Z
  Result:            [OK] Passed
  Events Verified:   16,777,216
```

</details>

---

## proof

Generate inclusion proof for an event.

```
caracal merkle proof [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--event-id` | `-e` | Yes | Event ID to generate proof for |
| `--output` | `-o` | No | Output file path |
| `--format` | `-f` | No | Output format: json or binary |

### Examples

<details>
<summary>Generate Proof</summary>

```bash
caracal merkle proof --event-id evt-001-aaaa-bbbb-cccc
```

**Output:**
```
Inclusion Proof for Event: evt-001-aaaa-bbbb-cccc
=================================================

Event Details
-------------
  Event ID:     evt-001-aaaa-bbbb-cccc
  Principal ID: 550e8400-e29b-41d4-a716-446655440000
  Type:         validated
  Resource:     api:external/openai
  Timestamp:    2024-01-15T14:30:45Z
  Event Hash:   b4c5d6e7f8a9...

Proof Path
----------
  Position:     Leaf #12,345,678
  Tree Height:  24
  Siblings:     24 hashes

  Level 0:  3a4b5c6d... (right)
  Level 1:  7e8f9a0b... (left)
  Level 2:  1c2d3e4f... (right)
  ...
  Level 23: 9k0l1m2n... (left)

Root Hash
---------
  Computed:     a7b3c8d1e5f2...
  Expected:     a7b3c8d1e5f2...
  Match:        [OK] Valid

Signature
---------
  Key ID:       key-001-aaaa-bbbb
  Signature:    MEUCIQD3x7y8...
  Verified:     [OK] Valid
```

</details>

<details>
<summary>Export to File</summary>

```bash
caracal merkle proof \
  --event-id evt-001-aaaa-bbbb-cccc \
  --output proof.json \
  --format json
```

**proof.json:**
```json
{
  "version": "1.0",
  "event_id": "evt-001-aaaa-bbbb-cccc",
  "event_hash": "b4c5d6e7f8a9...",
  "leaf_index": 12345678,
  "proof_path": [
    {"hash": "3a4b5c6d...", "position": "right"},
    {"hash": "7e8f9a0b...", "position": "left"},
    {"hash": "1c2d3e4f...", "position": "right"}
  ],
  "root_hash": "a7b3c8d1e5f2...",
  "signature": {
    "key_id": "key-001-aaaa-bbbb",
    "algorithm": "Ed25519",
    "value": "MEUCIQD3x7y8..."
  },
  "timestamp": "2024-01-15T14:32:00Z"
}
```

</details>

### Use Cases

| Use Case | Description |
|----------|-------------|
| Auditor verification | Provide proof to external auditors |
| Dispute resolution | Prove a transaction occurred |
| Regulatory compliance | Demonstrate data integrity |
| Cross-system verification | Verify events across systems |

---

## verify

Verify ledger integrity.

```
caracal merkle verify [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--full` | | false | Verify entire ledger (slow) |
| `--start-date` | `-s` | - | Start date (ISO 8601) |
| `--end-date` | `-e` | - | End date (ISO 8601) |
| `--parallel` | `-p` | 4 | Number of parallel workers |
| `--verbose` | `-v` | false | Show detailed progress |

### Examples

<details>
<summary>Quick Verification</summary>

```bash
caracal merkle verify
```

**Output:**
```
Verifying Merkle tree integrity...

Checking recent events (last 24 hours)...
  Events to verify: 45,678
  Progress: [====================] 100%

Results
-------
  Events Verified:  45,678
  Hashes Computed:  91,356
  Time Elapsed:     12.3s
  
  Status: [OK] All events verified successfully
```

</details>

<details>
<summary>Full Verification (Audit)</summary>

```bash
caracal merkle verify --full --parallel 8
```

**Output:**
```
Verifying FULL Merkle tree integrity...

[WARNING] This may take a long time for large ledgers.

Progress: [====================] 100%
  Events:     16,777,216 / 16,777,216
  Time:       3h 24m 15s

Results
-------
  Events Verified:   16,777,216
  Intermediate Nodes: 33,554,431
  Root Hash Match:   [OK] Valid
  Signatures Valid:  [OK] All 365 daily signatures verified

  Status: [OK] Full integrity verification passed
```

</details>

<details>
<summary>Verify Specific Period</summary>

```bash
caracal merkle verify \
  --start-date 2024-01-01T00:00:00Z \
  --end-date 2024-01-31T23:59:59Z \
  --verbose
```

</details>

### Integrity Violation

If tampering is detected:

```
Verifying Merkle tree integrity...

[ERROR] INTEGRITY VIOLATION DETECTED

Event: evt-001-aaaa-bbbb-cccc
  Expected Hash: b4c5d6e7f8a9...
  Computed Hash: 1a2b3c4d5e6f...
  
  This event has been modified after being recorded.

Affected Range
--------------
  First Bad Event: evt-001-aaaa-bbbb-cccc (2024-01-15T14:30:45Z)
  Events Affected: 45,678 (all events after the violation)

Recommended Actions
-------------------
  1. Investigate the source of modification
  2. Restore from last known good snapshot
  3. Replay events from Kafka if available
  4. Contact security team
```

---

## root

Get current or historical Merkle root.

```
caracal merkle root [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--at` | `-t` | - | Timestamp for historical root |
| `--format` | `-f` | text | Output format: text or json |

### Examples

<details>
<summary>Current Root</summary>

```bash
caracal merkle root
```

**Output:**
```
a7b3c8d1e5f29a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b
```

</details>

<details>
<summary>Historical Root</summary>

```bash
caracal merkle root --at 2024-01-15T00:00:00Z
```

</details>

<details>
<summary>JSON Format</summary>

```bash
caracal merkle root --format json
```

**Output:**
```json
{
  "root_hash": "a7b3c8d1e5f29a8b...",
  "tree_height": 24,
  "leaf_count": 16777216,
  "timestamp": "2024-01-15T14:32:00Z",
  "signature": {
    "key_id": "key-001-aaaa-bbbb",
    "value": "MEUCIQD3x7y8..."
  }
}
```

</details>

---

## export-proofs

Export proofs for audit.

```
caracal merkle export-proofs [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--agent-id` | `-a` | No | Filter by agent ID |
| `--start-date` | `-s` | No | Start date |
| `--end-date` | `-e` | No | End date |
| `--output` | `-o` | Yes | Output file path |
| `--format` | `-f` | No | Format: json or csv |

### Examples

<details>
<summary>Export for Audit</summary>

```bash
caracal merkle export-proofs \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --start-date 2024-01-01T00:00:00Z \
  --end-date 2024-01-31T23:59:59Z \
  --output january-audit.json
```

**Output:**
```
Exporting inclusion proofs...

  Agent:       550e8400-e29b-41d4-a716-446655440000
  Period:      2024-01-01 to 2024-01-31
  Events:      12,345
  
Progress: [====================] 100%

Exported to: january-audit.json
File size: 45.6 MB
```

</details>

---

## Best Practices

### Regular Verification

| Schedule | Command | Purpose |
|----------|---------|---------|
| Daily | `caracal merkle verify` | Verify last 24 hours |
| Weekly | `caracal merkle verify --start-date "7 days ago"` | Verify last week |
| Monthly | `caracal merkle verify --full` | Full verification |

### Audit Preparation

```bash
# 1. Verify integrity
caracal merkle verify --full

# 2. Export relevant proofs
caracal merkle export-proofs \
  --start-date 2024-01-01T00:00:00Z \
  --end-date 2024-12-31T23:59:59Z \
  --output annual-audit-2024.json

# 3. Get signed root hash
caracal merkle root --format json > root-signature-2024.json
```

---

## See Also

- [Policy Commands](./policy) - Authority policies for principals
- [Backup Commands](./backup) - Create backups
- [Ledger Commands](./ledger) - Query events
