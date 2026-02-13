---
sidebar_position: 2
title: Core vs Flow
---

# Caracal Core vs Caracal Flow

When to use each tool for effective Caracal deployment and management.

---

## Overview

| | Caracal Core | Caracal Flow | Caracal Enterprise |
|---|:---:|:---:|:---:|
| **Type** | Engine + CLI | Terminal UI (TUI) | Management Platform |
| **Interface** | Command-line, SDK, API | Interactive menus | Web Dashboard |
| **Use Case** | Automation, infrastructure | Day-to-day management | Multi-team compliance |
| **Scriptable** | Yes | No | API-driven |

---

## Feature Matrix

### Principal Management

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| Register principal | Yes | Yes |
| List principals | Yes | Yes |
| View details | Yes | Yes |
| Add metadata | Yes | Yes |
| Create child principals | Yes | Yes |
| Rotate keys | No | Yes |
| Bulk operations | No | Yes |

### Policy Management

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| Create authority policy | Yes | Yes |
| Set resource/action scopes | Yes | Yes |
| Set validity periods | Yes | Yes |
| View policy history | No | Yes |
| Compare policy versions | No | Yes |

### Authority Ledger

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View recent events | Yes | Yes |
| Filter by principal | Yes | Yes |
| Filter by time range | Limited | Yes |
| View delegation chain | No | Yes |
| Manage partitions | No | Yes |
| Archive old data | No | Yes |
| Export to CSV/JSON | No | Yes |

### Security and Cryptography

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View Merkle root | No | Yes |
| Generate inclusion proof | No | Yes |
| Verify ledger integrity | No | Yes |
| Rotate signing keys | No | Yes |

### Delegation

| Feature | Flow | Core CLI |
|---------|:----:|:--------:|
| View delegations | Yes | Yes |
| Generate delegation token | Limited | Yes |
| Validate token | No | Yes |
| Revoke delegation | No | Yes |

---

## When to Use Caracal Flow

Best for:

1. **First-time setup** -- Guided onboarding wizard
2. **Day-to-day management** -- Register principals, create policies
3. **Quick status checks** -- View authority events, service health
4. **Non-technical users** -- Operators who prefer visual interfaces

<details>
<summary>Launch commands</summary>

```bash
caracal-flow           # Start Flow
caracal-flow --reset   # Reset and re-run onboarding
```

</details>

---

## When to Use Caracal Core CLI

Best for:

1. **Automation** -- CI/CD pipelines, scripts
2. **Advanced operations** -- Merkle proofs, key rotation
3. **Recovery** -- DLQ management, event replay
4. **Infrastructure** -- Database migrations, Kafka setup
5. **Auditing** -- Ledger verification, proof export

<details>
<summary>Automation script example</summary>

```bash
# Automated principal provisioning
for name in $(cat principals.txt); do
  caracal agent register --name "$name" --owner team@company.com
done

# Verify ledger integrity
caracal merkle verify --start-date 2024-01-01

# Process dead letter queue
caracal dlq process --retry-failed
```

</details>

<details>
<summary>CI/CD example</summary>

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    steps:
      - name: Provision Principal
        run: |
          caracal agent register \
            --name "${{ github.event.inputs.principal_name }}" \
            --owner "${{ github.actor }}@company.com"
```

</details>

---

## Summary

| Task | Flow | Core CLI |
|------|:----:|:--------:|
| First-time setup | Yes | |
| Register principals | Yes | Yes |
| Create policies | Yes | Yes |
| View authority events | Yes | Yes |
| Run in CI/CD | | Yes |
| Verify ledger integrity | | Yes |
| Rotate keys | | Yes |
| Manage DLQ | | Yes |
| Generate audit reports | | Yes |

**Rule of thumb:**
- **Interactive work?** Use Flow
- **Automation or advanced ops?** Use Core CLI
