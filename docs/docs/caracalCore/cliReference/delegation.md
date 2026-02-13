---
sidebar_position: 7
title: Delegation Commands
---

# Delegation Commands

The `delegation` command group manages authority delegation between principals.

```
caracal delegation COMMAND [OPTIONS]
```

---

## Overview

Delegation allows a principal to transfer scoped authority to another principal.

```
+-------------------------------+
|        ORCHESTRATOR           |
|  Policy: api:external/*      |
+---------------+---------------+
                |
        Delegates Authority
                |
     +----------+----------+
     |          |          |
     v          v          v
+--------+ +--------+ +--------+
|Worker-1| |Worker-2| |Worker-3|
|api:ext/| |api:ext/| |db:read |
|openai  | |anthro  | |only    |
+--------+ +--------+ +--------+

Child mandates cannot exceed parent scope
```

### Properties

| Property | Description |
|----------|-------------|
| Hierarchical | Multi-level delegation chains supported |
| Scoped | Delegated authority cannot exceed parent |
| Time-limited | Tokens can have expiration dates |
| Revocable | Parent can revoke at any time |

---

## Commands

| Command | Description |
|---------|-------------|
| [`generate`](#generate) | Generate a delegation token |
| [`list`](#list) | List all delegations |
| [`validate`](#validate) | Validate a delegation token |
| [`revoke`](#revoke) | Revoke a delegation |

---

## generate

Generate a delegation token granting scoped authority.

```
caracal delegation generate [OPTIONS]
```

### Options

| Option | Short | Required | Default | Description |
|--------|-------|:--------:|---------|-------------|
| `--parent-id` | `-p` | Yes | - | Parent principal ID |
| `--child-id` | `-c` | Yes | - | Child principal ID |
| `--resources` | `-r` | Yes | - | Delegated resource scope |
| `--actions` | | Yes | - | Delegated action scope |
| `--max-validity` | | No | 86400 | Maximum mandate validity in seconds |
| `--expires` | `-e` | No | - | Delegation expiration (ISO 8601) |
| `--output` | `-o` | No | stdout | Output file path |

### Examples

<details>
<summary>Basic delegation</summary>

```bash
caracal delegation generate \
  --parent-id 550e8400-e29b-41d4-a716-446655440000 \
  --child-id 7a3b2c1d-e4f5-6789-abcd-ef0123456789 \
  --resources "api:external/openai" \
  --actions "execute"
```

**Output:**
```
Delegation Token Generated
==========================

Token ID:     tok-001-aaaa-bbbb-cccc
Parent:       orchestrator (550e8400-...)
Child:        worker-1 (7a3b2c1d-...)
Resources:    api:external/openai
Actions:      execute
Expires:      Never

Token (JWT):
eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...

Usage:
  1. Store this token securely
  2. Child principal includes token in X-Caracal-Delegation header
  3. Gateway validates delegation chain for each mandate
```

</details>

<details>
<summary>Delegation with expiration and constraints</summary>

```bash
caracal delegation generate \
  --parent-id 550e8400-e29b-41d4-a716-446655440000 \
  --child-id 7a3b2c1d-e4f5-6789-abcd-ef0123456789 \
  --resources "api:external/openai" "api:external/anthropic" \
  --actions "read" "execute" \
  --max-validity 3600 \
  --expires 2024-12-31T23:59:59Z
```

</details>

<details>
<summary>Save token to file</summary>

```bash
caracal delegation generate \
  --parent-id 550e8400-e29b-41d4-a716-446655440000 \
  --child-id 7a3b2c1d-e4f5-6789-abcd-ef0123456789 \
  --resources "api:external/*" \
  --actions "read" \
  --output delegation-token.jwt
```

</details>

---

## list

List all delegations.

```
caracal delegation list [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--parent-id` | `-p` | - | Filter by parent |
| `--child-id` | `-c` | - | Filter by child |
| `--status` | `-s` | active | Status: active, expired, revoked, all |
| `--format` | `-f` | table | Output format |

<details>
<summary>List active delegations</summary>

```bash
caracal delegation list
```

**Output:**
```
Active Delegations
==================

Token ID           Parent         Child          Resources             Actions     Expires
--------------------------------------------------------------------------------------------
tok-001-aaaa-...   orchestrator   worker-1       api:external/openai   execute     Never
tok-002-aaaa-...   orchestrator   worker-2       api:external/*        read,exec   2024-12-31

Total: 2 active delegations
```

</details>

---

## validate

Validate a delegation token.

```
caracal delegation validate [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--token` | `-t` | Yes | JWT token string or path to file |
| `--verbose` | `-v` | No | Show detailed validation steps |

<details>
<summary>Validate token</summary>

```bash
caracal delegation validate --token "eyJhbGciOiJFZERTQSIs..."
```

**Output:**
```
Token Validation
================

  Signature:        [OK] Valid (Ed25519)
  Not Expired:      [OK] No expiration set
  Not Revoked:      [OK] Token is active
  Parent Exists:    [OK] orchestrator (550e8400-...)
  Child Exists:     [OK] worker-1 (7a3b2c1d-...)
  Scope Valid:      [OK] Resources within parent policy

Result: [OK] Token is valid
```

</details>

### Invalid Token Causes

| Error | Cause |
|-------|-------|
| Token has expired | Expiration date has passed |
| Token was revoked | Parent revoked the delegation |
| Parent not found | Parent principal was deleted |
| Scope exceeded | Delegated scope exceeds parent policy |

---

## revoke

Revoke a delegation.

```
caracal delegation revoke [OPTIONS]
```

### Options

| Option | Short | Required | Description |
|--------|-------|:--------:|-------------|
| `--token-id` | `-t` | Yes | Token ID to revoke |
| `--reason` | `-r` | No | Reason for revocation |
| `--force` | | No | Skip confirmation prompt |

<details>
<summary>Revoke with reason</summary>

```bash
caracal delegation revoke \
  --token-id tok-001-aaaa-bbbb-cccc \
  --reason "Access no longer required"
```

</details>

---

## Best Practices

| Practice | Description |
|----------|-------------|
| Least privilege | Delegate minimum required resource scope |
| Short-lived tokens | Use expiration for temporary delegations |
| Revoke promptly | Remove access when no longer needed |
| Monitor events | Watch for denied events from delegated principals |

<details>
<summary>Provisioning script</summary>

```bash
#!/bin/bash
# provision-worker.sh

PARENT_ID="550e8400-e29b-41d4-a716-446655440000"
WORKER_NAME="$1"
RESOURCES="$2"

WORKER_ID=$(caracal agent register \
  --name "$WORKER_NAME" \
  --owner "ops@company.com" \
  --parent-id "$PARENT_ID" \
  --format json | jq -r '.agent_id')

caracal delegation generate \
  --parent-id "$PARENT_ID" \
  --child-id "$WORKER_ID" \
  --resources "$RESOURCES" \
  --actions "read" "execute" \
  --output "$WORKER_NAME-delegation.jwt"

echo "Worker provisioned: $WORKER_ID"
```

</details>

---

## See Also

- [Agent Commands](./agent) -- Register parent and child principals
- [Policy Commands](./policy) -- Define authority policies
- [Ledger Commands](./ledger) -- View delegation chain events
