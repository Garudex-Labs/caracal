---
sidebar_position: 2
title: Agent Commands
---

# Agent Commands

The `agent` command group manages principal identities in Caracal.

```
caracal agent COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`register`](#register) | Register a new principal |
| [`list`](#list) | List all registered principals |
| [`get`](#get) | Get details for a specific principal |

---

## register

Register a new principal (AI agent, user, or service).

```
caracal agent register [OPTIONS]
```

### Options

| Option | Short | Required | Default | Description |
|--------|-------|:--------:|---------|-------------|
| `--name` | `-n` | Yes | - | Unique human-readable name |
| `--owner` | `-o` | Yes | - | Owner identifier (email or username) |
| `--parent-id` | `-p` | No | - | Parent principal ID for hierarchical relationships |
| `--metadata` | `-m` | No | - | Key=value pairs (repeatable) |

### Validation Rules

| Rule | Description |
|------|-------------|
| Name uniqueness | Principal names must be unique across the registry |
| Parent validation | If --parent-id specified, parent must exist |

### Examples

<details>
<summary>Basic registration</summary>

```bash
caracal agent register \
  --name "my-agent" \
  --owner "user@example.com"
```

**Output:**
```
Principal registered successfully!

Principal ID: 550e8400-e29b-41d4-a716-446655440000
Name:         my-agent
Owner:        user@example.com
Created At:   2024-01-15T10:00:00Z
```

</details>

<details>
<summary>Registration with metadata</summary>

```bash
caracal agent register \
  --name "production-agent" \
  --owner "ops@example.com" \
  --metadata environment=production \
  --metadata team=platform \
  --metadata version=1.0.0
```

</details>

<details>
<summary>Child principal with parent</summary>

```bash
caracal agent register \
  --name "worker-1" \
  --owner "team@example.com" \
  --parent-id 550e8400-e29b-41d4-a716-446655440000
```

**Output:**
```
Principal registered successfully!

Principal ID:     7a3b2c1d-e4f5-6789-abcd-ef0123456789
Name:             worker-1
Owner:            team@example.com
Parent Principal: orchestrator (550e8400-e29b-41d4-a716-446655440000)
Created At:       2024-01-15T10:00:00Z
```

</details>

### Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Name already exists | Name is not unique | Choose a different name |
| Parent not found | Invalid parent ID | Verify parent exists |

---

## list

List all registered principals.

```
caracal agent list [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--format` | `-f` | table | Output format: table or json |

<details>
<summary>Table output</summary>

```bash
caracal agent list
```

**Output:**
```
Principal ID                          Name              Owner              Created            Parent
------------------------------------------------------------------------------------------------------
550e8400-e29b-41d4-a716-446655440000  orchestrator      admin@example.com  2024-01-15T10:00   -
7a3b2c1d-e4f5-6789-abcd-ef0123456789  worker-1          team@example.com   2024-01-15T10:05   orchestrator
```

</details>

<details>
<summary>Filter with jq</summary>

```bash
# Get only names
caracal agent list --format json | jq '.[].name'

# Find by owner
caracal agent list --format json | jq '.[] | select(.owner | contains("team"))'

# Get child principals
caracal agent list --format json | jq '.[] | select(.parent_agent_id != null)'
```

</details>

---

## get

Get detailed information about a specific principal.

```
caracal agent get [OPTIONS]
```

### Options

| Option | Short | Required | Default | Description |
|--------|-------|:--------:|---------|-------------|
| `--agent-id` | `-a` | Yes | - | Principal ID or name |
| `--format` | `-f` | No | table | Output format: table or json |

<details>
<summary>Get by ID</summary>

```bash
caracal agent get --agent-id 550e8400-e29b-41d4-a716-446655440000
```

**Output:**
```
Principal Details
=================

Principal ID:  550e8400-e29b-41d4-a716-446655440000
Name:          orchestrator
Owner:         admin@example.com
Created At:    2024-01-15T10:00:00Z
Parent:        None

Metadata:
  environment: production
  team:        platform

Child Principals:
  - worker-1 (7a3b2c1d-e4f5-6789-abcd-ef0123456789)
  - worker-2 (8b4c3d2e-f5a6-7890-bcde-f01234567890)

Active Policies:
  - Policy 001: resources=api:* actions=read,write
```

</details>

---

## Best Practices

### Naming Conventions

| Pattern | Example | Use Case |
|---------|---------|----------|
| Environment prefix | `prod-agent-1` | Distinguish environments |
| Team prefix | `platform-orchestrator` | Group by team |
| Hierarchy suffix | `main-worker-1` | Show relationships |

### Hierarchical Principals

```
+----------------------------------+
|          ORCHESTRATOR            |
+----------------+-----------------+
                 |
     +-----------+-----------+
     |           |           |
+----v----+ +----v----+ +----v----+
| Worker1 | | Worker2 | | Worker3 |
+---------+ +---------+ +---------+
```

- Child authority is scoped by parent delegation
- Track team-level activity in the ledger
- Revoke all children by revoking parent mandate

---

## See Also

- [Policy Commands](./policy) -- Create authority policies
- [Delegation Commands](./delegation) -- Manage authority delegation
- [Ledger Commands](./ledger) -- Query authority events
