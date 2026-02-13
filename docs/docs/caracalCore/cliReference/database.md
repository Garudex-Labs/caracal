---
sidebar_position: 5
title: Database Commands
---

# Database Commands

The `db` command group manages database schema and migrations.

```
caracal db COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`init-db`](#init-db) | Initialize database schema |
| [`migrate`](#migrate) | Run database migrations |
| [`status`](#status) | Check database connection and status |

---

## init-db

Initialize the database schema.

```
caracal db init-db [OPTIONS]
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--drop-existing` | false | Drop existing tables before creating (DESTRUCTIVE) |
| `--dry-run` | false | Show SQL without executing |

### Examples

<details>
<summary>Initialize Database</summary>

```bash
caracal db init-db
```

**Output:**
```
Initializing Caracal database schema...

Creating tables:
  [OK] agents
  [OK] policies
  [OK] policy_versions
  [OK] ledger_events
  [OK] delegation_tokens
  [OK] pending_mandates
  [OK] merkle_nodes
  [OK] snapshots
  [OK] dead_letter_queue

Creating indexes:
  [OK] idx_ledger_events_principal_id
  [OK] idx_ledger_events_timestamp
  [OK] idx_policies_principal_id
  ...

Creating materialized views:
  [OK] principal_daily_activity_mv
  [OK] principal_hourly_activity_mv

Database initialized successfully!
```

</details>

<details>
<summary>Dry Run (Preview SQL)</summary>

```bash
caracal db init-db --dry-run
```

**Output:**
```sql
-- DRY RUN: The following SQL would be executed

CREATE TABLE IF NOT EXISTS agents (
    principal_id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    owner VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ...
);

CREATE TABLE IF NOT EXISTS policies (
    policy_id UUID PRIMARY KEY,
    principal_id UUID REFERENCES agents(principal_id),
    ...
);

-- ... more SQL statements
```

</details>

### Warning

| Flag | Risk Level | Description |
|------|------------|-------------|
| `--drop-existing` | HIGH | Deletes ALL data - never use in production |

---

## migrate

Run database migrations.

```
caracal db migrate DIRECTION [OPTIONS]
```

### Arguments

| Argument | Values | Description |
|----------|--------|-------------|
| DIRECTION | `up`, `down` | Migration direction |

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--revision` | `-r` | head/-1 | Target revision |
| `--sql` | | false | Generate SQL instead of executing |

### Examples

<details>
<summary>Apply All Migrations</summary>

```bash
caracal db migrate up
```

**Output:**
```
Running migrations...

Applying: 001_initial_schema
  [OK] Created base tables

Applying: 002_add_policy_versions
  [OK] Added policy_versions table
  [OK] Added version triggers

Applying: 003_add_merkle_nodes
  [OK] Added merkle_nodes table
  [OK] Added merkle indexes

All migrations applied successfully!
Current revision: 003_add_merkle_nodes
```

</details>

<details>
<summary>Migrate to Specific Version</summary>

```bash
caracal db migrate up --revision 002_add_policy_versions
```

</details>

<details>
<summary>Revert Last Migration</summary>

```bash
caracal db migrate down
```

**Output:**
```
Reverting migration: 003_add_merkle_nodes
  [OK] Dropped merkle_nodes table
  [OK] Removed merkle indexes

Reverted successfully.
Current revision: 002_add_policy_versions
```

</details>

<details>
<summary>Generate SQL for DBA Review</summary>

```bash
caracal db migrate up --sql > migration.sql
```

</details>

---

## status

Check database connection and schema status.

```
caracal db status [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--format` | `-f` | table | Output format: table or json |

### Examples

<details>
<summary>Check Status</summary>

```bash
caracal db status
```

**Output:**
```
Database Status
===============

Connection
----------
  Host:       localhost:5432
  Database:   caracal
  User:       caracal
  Status:     [OK] Connected
  Latency:    2.3ms

Schema
------
  Current Revision:   003_add_merkle_nodes
  Pending Migrations: 0
  Last Applied:       2024-01-15T10:30:00Z

Tables
------
  agents:              125 rows
  policies:            89 rows
  policy_versions:     234 rows
  ledger_events:       1,234,567 rows
  delegation_tokens:   45 rows
  pending_mandates:  12 rows

Storage
-------
  Total Size:   2.3 GB
  Index Size:   450 MB
  Table Size:   1.85 GB
```

</details>

<details>
<summary>JSON Output</summary>

```bash
caracal db status --format json
```

**Output:**
```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "database": "caracal",
    "user": "caracal",
    "status": "connected",
    "latency_ms": 2.3
  },
  "schema": {
    "current_revision": "003_add_merkle_nodes",
    "pending_migrations": 0,
    "last_applied": "2024-01-15T10:30:00Z"
  },
  "tables": {
    "agents": 125,
    "policies": 89,
    "ledger_events": 1234567
  },
  "storage": {
    "total_bytes": 2469606195,
    "index_bytes": 471859200,
    "table_bytes": 1986490163
  }
}
```

</details>

---

## Configuration

### Configuration File

```yaml
database:
  type: postgres
  host: localhost
  port: 5432
  database: caracal
  user: caracal
  password: "${DB_PASSWORD}"
  
  # Connection pool settings
  pool_size: 10
  max_overflow: 20
  pool_timeout: 30
  pool_recycle: 1800
  
  # SSL settings (production)
  ssl_mode: require
  ssl_ca: /path/to/ca.crt
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DB_HOST` | Database hostname |
| `DB_PORT` | Database port |
| `DB_NAME` | Database name |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_SSL_MODE` | SSL mode |

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| Connection refused | PostgreSQL not running | Start PostgreSQL: `docker-compose up -d postgres` |
| Authentication failed | Wrong credentials | Check DB_PASSWORD environment variable |
| Target not up to date | Pending migrations | Run `caracal db migrate up` |

---

## See Also

- [Ledger Commands](./ledger) - Query data in the database
- [Backup Commands](./backup) - Backup database state
