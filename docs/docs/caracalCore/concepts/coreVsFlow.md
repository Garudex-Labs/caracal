---
sidebar_position: 2
title: Core vs Flow
---

# Caracal Core vs Caracal Flow

Understanding when to use each tool for effective Caracal deployment and management.

---

## Overview

| | Caracal Core | Caracal Flow | Caracal Enterprise |
|---|:---:|:---:|:---:|
| **Type** | Engine + CLI | Terminal UI (TUI) | Management Platform |
| **Interface** | Command-line, SDK, API | Interactive menus | Web Dashboard |
| **Use Case** | Automation, infrastructure, recovery | Day-to-day management, onboarding | Multi-team management, compliance |
| **Skill Level** | DevOps/Engineering | All users | Admins/Managers |
| **Scriptable** | Yes | No | API-driven |

---

## Quick Comparison

```
+------------------------------------------------------------------+
|                        CARACAL ECOSYSTEM                          |
+------------------------------------------------------------------+
|                                                                   |
|  +---------------------------+  +---------------------------+     |
|  |      CARACAL FLOW         |  |      CARACAL CORE         |     |
|  |     (TUI Interface)       |  |     (Engine + CLI)        |     |
|  +---------------------------+  +---------------------------+     |
|  |                           |  |                           |     |
|  |  - Visual menus           |  |  - Full CLI access        |     |
|  |  - Guided wizards         |  |  - SDK integration        |     |
|  |  - Quick setup            |  |  - Scriptable             |     |
|  |  - Agent management       |  |  - Recovery tools         |     |
|  |  - Policy creation        |  |  - Infrastructure         |     |
|  |  - Spending overview      |  |  - Merkle proofs          |     |
|  |                           |  |  - Key management         |     |
|  +-----------+---------------+  +-------------+-------------+     |
|              |                                |                   |
|              |           Uses                 |                   |
|              +----------------+---------------+                   |
|                               |                                   |
|                               v                                   |
|  +------------------------------------------------------------+   |
|  |                     CARACAL ENGINE                         |   |
|  |   Policy Evaluation | Ledger | Merkle Tree | Gateway       |   |
|  +------------------------------------------------------------+   |
+------------------------------------------------------------------+
```

---

## Feature Matrix

### Agent Management

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| Register agent | Yes | Yes |
| List agents | Yes | Yes |
| View agent details | Yes | Yes |
| Add metadata | Yes | Yes |
| Create child agents | Yes | Yes |
| Rotate agent keys | No | Yes |
| Bulk operations | No | Yes |

### Policy Management

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| Create simple budget | Yes | Yes |
| Daily/weekly/monthly windows | Yes | Yes |
| Rolling vs calendar windows | No | Yes |
| View policy history | No | Yes |
| Compare policy versions | No | Yes |
| Time-travel queries | No | Yes |

### Ledger Operations

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View recent spending | Yes | Yes |
| Agent spending summary | Yes | Yes |
| Filter by time/amount | Limited | Yes |
| View delegation chain | No | Yes |
| Manage partitions | No | Yes |
| Archive old data | No | Yes |
| Export to CSV/JSON | No | Yes |

### Infrastructure and Operations

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| Start Docker containers | Yes | N/A |
| Database status check | Yes | Yes |
| Run migrations | No | Yes |
| Kafka topic management | No | Yes |
| Create/restore snapshots | No | Yes |
| Event replay | No | Yes |
| DLQ management | No | Yes |

### Security and Cryptography

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View Merkle root | No | Yes |
| Generate inclusion proof | No | Yes |
| Verify ledger integrity | No | Yes |
| Rotate signing keys | No | Yes |
| Encrypt configuration | No | Yes |
| Manage allowlists | No | Yes |

### Delegation

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View delegations | Yes | Yes |
| Generate delegation token | Limited | Yes |
| Validate token | No | Yes |
| Revoke delegation | No | Yes |

---

## When to Use Caracal Flow

### Best For

1. **First-time setup** - Guided onboarding wizard
2. **Day-to-day management** - Create agents, set budgets
3. **Quick status checks** - View spending, service health
4. **Non-technical users** - Product managers, finance teams
5. **Learning Caracal** - Explore features visually

### Example Workflows

<details>
<summary>Launch Flow for interactive management</summary>

```bash
# Launch Flow for interactive management
caracal-flow

# Reset and re-run onboarding
caracal-flow --reset
```

</details>

**Flow is ideal when you need to:**
- Set up a new agent quickly
- Check current spending
- Start/stop Docker services
- Get a visual overview of the system

---

## When to Use Caracal Core CLI

### Best For

1. **Automation** - CI/CD pipelines, scripts
2. **Advanced operations** - Merkle proofs, key rotation
3. **Recovery** - DLQ management, event replay
4. **Infrastructure** - Database migrations, Kafka setup
5. **Auditing** - Policy history, version comparison
6. **Integration** - Programmatic access via SDK

### Example Workflows

<details>
<summary>Automation scripts and CI/CD</summary>

```bash
# Automated agent provisioning script
for agent in $(cat agents.txt); do
  caracal agent register --name "$agent" --owner team@company.com
done

# Daily backup in cron
0 2 * * * caracal backup create --type full

# Verify ledger integrity
caracal merkle verify --start-date 2024-01-01

# Process dead letter queue
caracal dlq process --retry-failed

# Generate audit report
caracal ledger query --format json | jq '...' > audit.json
```

</details>

---

## Feature Deep Dive: What's Only in Core CLI

### 1. Merkle Tree Operations

<details>
<summary>Merkle tree commands</summary>

```bash
# View current Merkle root
caracal merkle status

# Generate inclusion proof for an event
caracal merkle proof --event-id evt-001-aaaa-bbbb

# Verify the entire ledger (audit)
caracal merkle verify --full

# Rotate the signing key
caracal keys rotate --key-type merkle-signing
```

</details>

### 2. Event Recovery

<details>
<summary>Recovery commands</summary>

```bash
# View dead letter queue
caracal dlq list

# Retry failed events
caracal dlq process --retry-failed --limit 100

# Replay events from Kafka
caracal replay start --from-offset 12345 --to-offset 67890

# Create point-in-time snapshot
caracal snapshot create --name "before-migration"

# Restore from snapshot
caracal snapshot restore --name "before-migration"
```

</details>

### 3. Resource Allowlists

<details>
<summary>Allowlist commands</summary>

```bash
# Add allowed URL pattern
caracal allowlist add \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --pattern "https://api.openai.com/*"

# List allowlist rules
caracal allowlist list --agent-id 550e8400-e29b-41d4-a716-446655440000

# Remove rule
caracal allowlist remove --rule-id rule-001
```

</details>

### 4. Configuration Encryption

<details>
<summary>Encryption commands</summary>

```bash
# Encrypt a value
caracal config-encryption encrypt --value "my-secret-password"
# Output: ENC[AES256_GCM,data:xxx,iv:yyy,tag:zzz]

# Use in config.yaml
database:
  password: ENC[AES256_GCM,data:xxx,iv:yyy,tag:zzz]

# Decrypt for verification
caracal config-encryption decrypt --value "ENC[...]"
```

</details>

### 5. Delegation Token Management

<details>
<summary>Delegation commands</summary>

```bash
# Generate delegation token
caracal delegation generate \
  --parent-id 550e8400-e29b-41d4-a716-446655440000 \
  --child-id 7a3b2c1d-e4f5-6789-abcd-ef0123456789 \
  --budget 100.00 \
  --expires 2024-12-31

# Validate a token
caracal delegation validate --token "eyJhbG..."

# Revoke delegation
caracal delegation revoke \
  --token-id tok-001 \
  --reason "Budget exceeded"

# List all delegations
caracal delegation list --parent-id 550e8400-e29b-41d4-a716-446655440000
```

</details>

---

## Integration Patterns

### Pattern 1: Flow for Setup, CLI for Operations

<details>
<summary>Setup then automate</summary>

```bash
# 1. Use Flow for initial setup
caracal-flow  # Complete onboarding wizard

# 2. Use CLI for automation
cat << 'EOF' > setup-agents.sh
#!/bin/bash
for i in {1..10}; do
  caracal agent register --name "worker-$i" --owner ops@company.com
done
EOF
chmod +x setup-agents.sh
./setup-agents.sh
```

</details>

### Pattern 2: CLI in CI/CD

<details>
<summary>GitHub Actions example</summary>

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    steps:
      - name: Provision Agent
        run: |
          caracal agent register \
            --name "${{ github.event.inputs.agent_name }}" \
            --owner "${{ github.actor }}@company.com"
          
          caracal policy create \
            --agent-id $(caracal agent list --format json | jq -r '.[0].agent_id') \
            --limit 100.00
```

</details>

### Pattern 3: SDK for Application Integration

<details>
<summary>Python SDK example</summary>

```python
from caracal.sdk import CaracalClient

# Initialize client
client = CaracalClient()

# Register agent programmatically
agent = client.register_agent(
    name="my-app-agent",
    owner="app@company.com"
)

# Create policy
policy = client.create_policy(
    agent_id=agent.agent_id,
    limit=100.00,
    time_window="daily"
)

# Track spending
result = client.record_spend(
    agent_id=agent.agent_id,
    amount=0.05,
    operation_type="gpt-4-completion"
)
```

</details>

---

## Summary

| Task | Use Flow | Use Core CLI |
|------|:--------:|:------------:|
| First-time setup | Yes | |
| Create an agent | Yes | Yes |
| Set a budget | Yes | Yes |
| Check spending | Yes | Yes |
| Run in CI/CD | | Yes |
| Verify ledger integrity | | Yes |
| Rotate keys | | Yes |
| Manage DLQ | | Yes |
| Create snapshots | | Yes |
| Generate audit reports | | Yes |

**Rule of thumb:**
- **Interactive work?** Use Flow
- **Automation or advanced ops?** Use Core CLI
