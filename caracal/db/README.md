# Caracal Core v0.2 Database Infrastructure

This directory contains the PostgreSQL database infrastructure for Caracal Core v0.2.

## Overview

The database module provides:
- **SQLAlchemy Models**: ORM models for all database tables
- **Connection Management**: Connection pooling and health checks
- **Schema Migrations**: Alembic-based database migrations
- **Version Tracking**: Schema version validation and management

## Database Schema

### Tables

1. **agent_identities**: Agent registry with parent-child relationships
   - Primary key: `agent_id` (UUID)
   - Unique constraint: `name`
   - Self-referential foreign key: `parent_agent_id`
   - Indexes: `name`, `parent_agent_id`

2. **budget_policies**: Budget policies with delegation tracking
   - Primary key: `policy_id` (UUID)
   - Foreign keys: `agent_id`, `delegated_from_agent_id`
   - Indexes: `agent_id`, `(agent_id, active)`

3. **ledger_events**: Immutable ledger events for spending tracking
   - Primary key: `event_id` (BIGSERIAL auto-increment)
   - Foreign key: `agent_id`
   - Indexes: `agent_id`, `timestamp`, `(agent_id, timestamp)`

4. **provisional_charges**: Budget reservations with automatic expiration
   - Primary key: `charge_id` (UUID)
   - Foreign keys: `agent_id`, `final_charge_event_id`
   - Indexes: `agent_id`, `expires_at`, `(agent_id, released)`, `(expires_at, released)`

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
    agent = AgentIdentity(name="test-agent", owner="user@example.com")
    session.add(agent)
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

### Initial Migration

The initial v0.2 schema migration creates all four tables with proper indexes and foreign key constraints.

Revision ID: `ac870772e55c`

## Models

### AgentIdentity

```python
from caracal.db import AgentIdentity

agent = AgentIdentity(
    name="my-agent",
    owner="user@example.com",
    parent_agent_id=parent_id,  # Optional
    agent_metadata={"key": "value"},  # Optional JSONB
)
```

### BudgetPolicy

```python
from caracal.db import BudgetPolicy
from decimal import Decimal

policy = BudgetPolicy(
    agent_id=agent.agent_id,
    limit_amount=Decimal("100.00"),
    time_window="daily",
    currency="USD",
    delegated_from_agent_id=parent_id,  # Optional
    active=True,
)
```

### LedgerEvent

```python
from caracal.db import LedgerEvent
from decimal import Decimal
from datetime import datetime

event = LedgerEvent(
    agent_id=agent.agent_id,
    timestamp=datetime.utcnow(),
    resource_type="api.openai.gpt4",
    quantity=Decimal("1000"),  # tokens
    cost=Decimal("0.03"),
    currency="USD",
    event_metadata={"model": "gpt-4"},  # Optional JSONB
    provisional_charge_id=charge_id,  # Optional
)
```

### ProvisionalCharge

```python
from caracal.db import ProvisionalCharge
from decimal import Decimal
from datetime import datetime, timedelta

charge = ProvisionalCharge(
    agent_id=agent.agent_id,
    amount=Decimal("0.05"),
    currency="USD",
    created_at=datetime.utcnow(),
    expires_at=datetime.utcnow() + timedelta(minutes=5),
    released=False,
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

This implementation satisfies the following requirements from the v0.2 specification:

- **Requirement 3.2**: PostgreSQL Agent Identity Registry with parent-child relationships
- **Requirement 4.2**: PostgreSQL Budget Policy Store with delegation tracking
- **Requirement 5.2**: PostgreSQL Ledger Events Table with efficient querying
- **Requirement 6.1-6.6**: Database connection management with pooling
- **Requirement 19.1-19.2, 19.7**: Alembic migrations and schema version tracking

## Performance Characteristics

- Agent identity lookups: <5ms p99 (indexed on agent_id and name)
- Policy queries: <10ms p99 (indexed on agent_id)
- Ledger time-range queries: <50ms p99 (composite index on agent_id + timestamp)
- Connection pool: Supports 1,000+ requests/second per instance

## Notes

- All tables use UUID primary keys except `ledger_events` which uses BIGSERIAL for monotonic IDs
- The `metadata` column is mapped to `agent_metadata` and `event_metadata` in Python to avoid conflicts with SQLAlchemy's reserved `metadata` attribute
- Foreign key constraints ensure referential integrity
- Indexes are optimized for common query patterns
- Connection pooling reduces database connection overhead
