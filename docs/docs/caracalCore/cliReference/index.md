---
sidebar_position: 1
title: CLI Reference
---

# Caracal CLI Reference

Complete reference for all Caracal Core command-line interface commands.

```
caracal [GLOBAL OPTIONS] COMMAND [COMMAND OPTIONS]
```

---

## Global Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--config` | `-c` | `~/.caracal/config.yaml` | Path to configuration file |
| `--log-level` | `-l` | `INFO` | Logging level |
| `--verbose` | `-v` | false | Enable verbose output |
| `--version` | | | Show version and exit |
| `--help` | | | Show help message |

---

## Command Groups

```
caracal
  |
  +-- agent           Manage principal identities
  |     +-- register      Register new principal
  |     +-- list          List all principals
  |     +-- get           Get principal details
  |
  +-- policy          Manage authority policies
  |     +-- create        Create policy
  |     +-- list          List policies
  |     +-- get           Get policy details
  |     +-- history       View change history
  |
  +-- ledger          Query authority events
  |     +-- query         Query events
  |     +-- summary       Principal activity summary
  |     +-- delegation-chain   Trace delegation
  |     +-- list-partitions    List partitions
  |
  +-- delegation      Manage authority delegation
  |     +-- generate      Generate delegation token
  |     +-- list          List delegations
  |     +-- validate      Validate token
  |     +-- revoke        Revoke delegation
  |
  +-- db              Database management
  |     +-- init-db       Initialize schema
  |     +-- migrate       Run migrations
  |     +-- status        Check connection
  |
  +-- merkle          Cryptographic integrity
  |     +-- status        Tree status
  |     +-- proof         Generate proof
  |     +-- verify        Verify integrity
  |
  +-- backup          Backup and restore
  |     +-- create        Create backup
  |     +-- restore       Restore from backup
  |     +-- list          List backups
  |
  +-- kafka           Kafka management
  |     +-- status        Check connection
  |     +-- topics        List topics
  |
  +-- keys            Key management
        +-- list          List keys
        +-- rotate        Rotate keys
        +-- export        Export public key
```

---

## Command Reference

| Command Group | Description | Documentation |
|--------------|-------------|---------------|
| agent | Register and manage principal identities | [Agent Commands](./agent) |
| policy | Create and manage authority policies | [Policy Commands](./policy) |
| ledger | Query the authority event ledger | [Ledger Commands](./ledger) |
| delegation | Manage authority delegation | [Delegation Commands](./delegation) |
| db | Database schema and migrations | [Database Commands](./database) |
| merkle | Cryptographic integrity verification | [Merkle Commands](./merkle) |
| backup | Backup and restore operations | [Backup Commands](./backup) |
| kafka | Kafka event stream management | [Kafka Commands](./kafka) |
| keys | Cryptographic key management | [Key Commands](./keys) |

---

## Quick Examples

<details>
<summary>Register a principal and create a policy</summary>

```bash
caracal agent register \
  --name "my-agent" \
  --owner "user@example.com"

# Output:
# Principal registered successfully!
# Principal ID: 550e8400-e29b-41d4-a716-446655440000

caracal policy create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --resources "api:external/*" \
  --actions "read" "write" \
  --max-validity 86400
```

</details>

<details>
<summary>Query authority events</summary>

```bash
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --limit 5 \
  --format table
```

</details>

<details>
<summary>Verify ledger integrity</summary>

```bash
caracal merkle status
caracal merkle verify --full --parallel 8
```

</details>

<details>
<summary>Database operations</summary>

```bash
caracal db init-db
caracal db status
caracal db migrate up
```

</details>

---

## Configuration

### Configuration File

Default location: `~/.caracal/config.yaml`

```yaml
storage:
  agent_registry: ~/.caracal/agents.json
  policy_store: ~/.caracal/policies.json
  ledger: ~/.caracal/ledger.jsonl
  backup_dir: ~/.caracal/backups
  backup_count: 3

logging:
  level: INFO
  file: ~/.caracal/caracal.log

database:
  type: postgres
  host: localhost
  port: 5432
  database: caracal
  user: caracal
  password: "${DB_PASSWORD}"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CARACAL_CONFIG` | Override default config path |
| `CARACAL_LOG_LEVEL` | Override log level |
| `DB_PASSWORD` | Database password |
| `CARACAL_MASTER_PASSWORD` | Password for config encryption |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error |
| 3 | Database connection error |
| 4 | Authentication error |
| 5 | Authority denied |
| 6 | Resource not found |

---

## Output Formats

| Format | Option | Description |
|--------|--------|-------------|
| Table | `--format table` | Human-readable table (default) |
| JSON | `--format json` | Machine-readable JSON |

---

## See Also

- [SDK Client Reference](/caracalCore/apiReference/sdkClient) -- Python SDK
- [MCP Integration](/caracalCore/apiReference/mcpIntegration) -- Model Context Protocol
- [Core vs Flow](/caracalCore/concepts/coreVsFlow) -- When to use each tool
