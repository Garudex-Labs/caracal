# Caracal Core v0.5 Database Infrastructure

This directory contains the PostgreSQL database infrastructure for Caracal Core v0.5.

## Overview

The database module provides:
- **SQLAlchemy Models**: ORM models for all database tables
- **Connection Management**: Connection pooling and health checks
- **Schema Migrations**: Alembic-based database migrations
- **Version Tracking**: Schema version validation and management

## Database Schema

### Tables

1. **principals**: Principal identities (agents, users, services)
   - Primary key: `principal_id` (UUID)
   - Unique constraint: `name`
   - Self-referential foreign key: `parent_principal_id`
   - Indexes: `name`, `parent_principal_id`, `principal_type`

2. **execution_mandates**: Authority mandates
   - Primary key: `mandate_id` (UUID)
   - Foreign keys: `issuer_id`, `subject_id`, `parent_mandate_id`
   - Indexes: `issuer_id`, `subject_id`, `(subject_id, valid_until)`, `revoked`

3. **ledger_events**: Immutable ledger events for spending tracking
   - Primary key: `event_id` (BIGSERIAL auto-increment)
   - Foreign key: `agent_id` (references `principals.principal_id`)
   - Indexes: `agent_id`, `timestamp`, `(agent_id, timestamp)`

4. **authority_ledger_events**: Immutable authority events
   - Primary key: `event_id` (BIGSERIAL auto-increment)
   - Foreign keys: `principal_id`, `mandate_id`
   - Indexes: `principal_id`, `mandate_id`, `timestamp`

5. **authority_policies**: Mandate issuance policies
   - Primary key: `policy_id` (UUID)
   - Foreign key: `principal_id`
   - Indexes: `principal_id`, `active`

6. **merkle_roots**: Merkle roots for cryptographic integrity
   - Primary key: `root_id` (UUID)
   - Unique: `batch_id`

7. **ledger_snapshots**: Ledger state snapshots
   - Primary key: `snapshot_id` (UUID)

## Usage

### Initialize Database Connection

```python
from caracal.db import DatabaseConfig, initialize_connection_manager

# Configure database connection
config = DatabaseConfig(
    host="localhost",
    port=5432,
    database="caracal",
    user="caracal",
    password="your_password",
    pool_size=10,
    max_overflow=5,
)

# Initialize connection manager
db_manager = initialize_connection_manager(config)

# Use with context manager for transactions
with db_manager.session_scope() as session:
    # Perform database operations
    principal = Principal(name="test-agent", type="agent", owner="user@example.com")
    session.add(principal)
    # Commit happens automatically on success
```

### Check Schema Version

```python
from caracal.db import check_schema_version_on_startup

# Check schema version on startup (fails if outdated)
check_schema_version_on_startup(db_manager._engine)
```

### Run Migrations

```bash
# Check current migration status
alembic current

# Show pending migrations
alembic history

# Upgrade to latest version
alembic upgrade head

# Downgrade one version
alembic downgrade -1

# Show SQL without executing
alembic upgrade head --sql
```

## Configuration

### Environment Variables

- `CARACAL_DATABASE_URL`: Override database URL from alembic.ini
  - Format: `postgresql://user:password@host:port/database`

### Connection Pool Settings

Default configuration:
- Pool size: 10 connections
- Max overflow: 5 additional connections
- Pool timeout: 30 seconds
- Pool recycle: 3600 seconds (1 hour)

## Migration Management

### Creating New Migrations

```bash
# Auto-generate migration from model changes
alembic revision --autogenerate -m "Description of changes"

# Create empty migration
alembic revision -m "Description of changes"
```

### Migration File Location

Migrations are stored in: `caracal/db/migrations/versions/`

## Models

### Principal

```python
from caracal.db import Principal

principal = Principal(
    name="my-agent",
    principal_type="agent",
    owner="user@example.com",
    parent_principal_id=parent_id,  # Optional
    principal_metadata={"key": "value"},  # Optional JSONB
)
```

### ExecutionMandate

```python
from caracal.db import ExecutionMandate
from datetime import datetime, timedelta

mandate = ExecutionMandate(
    issuer_id=issuer.principal_id,
    subject_id=subject.principal_id,
    valid_from=datetime.utcnow(),
    valid_until=datetime.utcnow() + timedelta(days=1),
    resource_scope=["*"],
    action_scope=["*"],
    signature="...",
)
```

### LedgerEvent

```python
from caracal.db import LedgerEvent
from decimal import Decimal
from datetime import datetime

event = LedgerEvent(
    agent_id=principal.principal_id,
    timestamp=datetime.utcnow(),
    resource_type="api.openai.gpt4",
    quantity=Decimal("1000"),  # tokens
    cost=Decimal("0.03"),
    currency="USD",
    event_metadata={"model": "gpt-4"},  # Optional JSONB
)
```

## Health Checks

```python
# Check database connectivity
is_healthy = db_manager.health_check()

# Get connection pool status
pool_status = db_manager.get_pool_status()
print(f"Pool size: {pool_status['size']}")
print(f"Checked out: {pool_status['checked_out']}")
print(f"Overflow: {pool_status['overflow']}")
```

## Requirements Satisfied

This implementation satisfies the following requirements from the v0.5 specification:

- **Requirement 1.2**: Principal Identity Registry
- **Requirement 1.5**: Execution Mandates with cryptographic signatures
- **Requirement 2.1**: Immutable Ledger Events
- **Requirement 2.2**: Authority Ledger Events
- **Requirement 6.1-6.6**: Database connection management with pooling
- **Requirement 19.1**: Alembic migrations

## Notes

- All tables use UUID primary keys except `ledger_events` and `authority_ledger_events` which use BIGSERIAL for monotonic IDs
- The `metadata` column is mapped to `principal_metadata`, `mandate_metadata`, etc. in Python to avoid conflicts with SQLAlchemy's reserved `metadata` attribute
- Foreign key constraints ensure referential integrity
- Indexes are optimized for common query patterns
- Connection pooling reduces database connection overhead
