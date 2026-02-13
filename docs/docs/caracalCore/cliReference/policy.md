---
sidebar_position: 3
title: Policy Commands
---

# Policy Commands

The `policy` command group manages authority policies for principals.

```
caracal policy COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`create`](#create) | Create a new authority policy |
| [`list`](#list) | List all policies |
| [`get`](#get) | Get policy details |
| [`history`](#history) | View policy change history |

---

## create

Create a new authority policy for a principal.

```
caracal policy create [OPTIONS]
```

### Options

| Option | Short | Required | Default | Description |
|--------|-------|:--------:|---------|-------------|
| `--agent-id` | `-a` | Yes | - | Principal ID this policy applies to |
| `--resources` | `-r` | Yes | - | Allowed resource patterns (supports wildcards) |
| `--actions` | | Yes | - | Allowed actions (read, write, execute) |
| `--max-validity` | | No | 86400 | Maximum mandate validity in seconds |
| `--delegation-depth` | | No | 0 | Maximum delegation chain depth |

### Examples

<details>
<summary>Basic policy</summary>

```bash
caracal policy create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --resources "api:external/*" \
  --actions "read" "write" \
  --max-validity 86400
```

**Output:**
```
Policy created successfully!

Policy ID:         pol-001-aaaa-bbbb-cccc
Principal ID:      550e8400-e29b-41d4-a716-446655440000
Resources:         api:external/*
Actions:           read, write
Max Validity:      86400s (24h)
Delegation Depth:  0
Created At:        2024-01-15T10:00:00Z
```

</details>

<details>
<summary>Policy with delegation</summary>

```bash
caracal policy create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --resources "api:external/*" "db:analytics/*" \
  --actions "read" "write" "execute" \
  --max-validity 3600 \
  --delegation-depth 2
```

This policy allows the principal to delegate authority up to 2 levels deep.

</details>

---

## list

List all policies.

```
caracal policy list [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--agent-id` | `-a` | - | Filter by principal ID |
| `--format` | `-f` | table | Output format: table or json |

<details>
<summary>List all policies</summary>

```bash
caracal policy list
```

**Output:**
```
Policy ID                             Principal          Resources           Actions      Max Validity
---------------------------------------------------------------------------------------------------------
pol-001-aaaa-bbbb-cccc                orchestrator       api:external/*      read,write   86400s
pol-002-aaaa-bbbb-cccc                worker-1           api:external/sub    read         3600s
```

</details>

---

## get

Get details for a specific policy.

```
caracal policy get [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--policy-id` | `-p` | Yes | Policy ID |
| `--format` | `-f` | No | Output format: table or json |

<details>
<summary>Get policy details</summary>

```bash
caracal policy get --policy-id pol-001-aaaa-bbbb-cccc
```

**Output:**
```
Policy Details
==============

Policy ID:         pol-001-aaaa-bbbb-cccc
Principal ID:      550e8400-e29b-41d4-a716-446655440000
Principal Name:    orchestrator
Resources:         api:external/*
Actions:           read, write
Max Validity:      86400s (24h)
Delegation Depth:  0
Created At:        2024-01-15T10:00:00Z
Version:           1
```

</details>

---

## history

View policy change history.

```
caracal policy history [OPTIONS]
```

> Note: Requires database backend.

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--policy-id` | `-p` | Yes | Policy ID |
| `--start-time` | `-s` | No | Start time (ISO 8601) |
| `--end-time` | `-e` | No | End time (ISO 8601) |
| `--format` | `-f` | No | Output format |

<details>
<summary>View full history</summary>

```bash
caracal policy history --policy-id pol-001-aaaa-bbbb-cccc
```

**Output:**
```
Policy History: pol-001-aaaa-bbbb-cccc
======================================

Version  Change Type     Changed At              Changed By       Details
----------------------------------------------------------------------------------
2        scope_changed   2024-01-20T14:30:00Z    admin           Added db:* resources
1        created         2024-01-01T10:00:00Z    admin           Initial policy
```

</details>

---

## Best Practices

### Policy Design

| Scenario | Recommended Setup |
|----------|-------------------|
| Read-only agent | `actions=read`, narrow resource scope |
| Full-access orchestrator | Broad resource scope, delegation enabled |
| Scoped worker | Narrow resource scope, short max validity |
| Audit-safe | No delegation depth, short validity windows |

---

## See Also

- [Agent Commands](./agent) -- Register principals
- [Delegation Commands](./delegation) -- Manage authority delegation
- [Ledger Commands](./ledger) -- Query authority events
