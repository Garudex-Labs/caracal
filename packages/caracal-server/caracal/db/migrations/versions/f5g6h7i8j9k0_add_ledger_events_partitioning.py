"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add table partitioning for ledger_events

Revision ID: f5g6h7i8j9k0
Revises: e4f5g6h7i8j9
Create Date: 2026-02-03 11:00:00.000000

Converts ledger_events table to partitioned table by month.
Creates partitions for current month and next 3 months.

IMPORTANT: This migration requires careful execution in production:
1. It will lock the ledger_events table during conversion
2. For large tables, consider using pg_partman or manual partitioning
3. Test thoroughly in staging environment first

"""
from typing import Sequence, Union
from datetime import datetime, timedelta

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f5g6h7i8j9k0'
down_revision: Union[str, Sequence[str], None] = 'e4f5g6h7i8j9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Upgrade schema to use partitioned ledger_events table.
    
    WARNING: This migration will lock the ledger_events table during conversion.
    For production systems with large tables, consider:
    1. Using pg_partman for online partitioning
    2. Creating partitioned table separately and migrating data in batches
    3. Scheduling during maintenance window
    """
    
    # Step 1: Rename existing table to temporary name
    op.execute("ALTER TABLE ledger_events RENAME TO ledger_events_old;")
    
    # Drop all indexes on the renamed table so they can be recreated on the
    # new partitioned table without name conflicts.
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_principal_id;")
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_timestamp;")
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_agent_timestamp;")
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_resource_type;")
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_provisional_charge_id;")
    op.execute("DROP INDEX IF EXISTS ix_ledger_events_agent_resource_timestamp;")
    
    # Step 2: Create new partitioned table with same structure
    op.execute("""
        CREATE TABLE ledger_events (
            event_id BIGSERIAL,
            principal_id UUID NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            resource_type VARCHAR(255) NOT NULL,
            quantity NUMERIC(20, 6) NOT NULL,
            cost NUMERIC(20, 6) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'USD',
            metadata JSONB,
            provisional_charge_id UUID,
            PRIMARY KEY (event_id, timestamp),
            FOREIGN KEY (principal_id) REFERENCES principal_identities(principal_id)
        ) PARTITION BY RANGE (timestamp);
    """)
    
    # Step 3: Create partitions for current month and next 3 months
    current_date = datetime.utcnow()
    
    for i in range(4):
        partition_date = current_date + timedelta(days=30 * i)
        year = partition_date.year
        month = partition_date.month
        
        # Calculate partition bounds
        start_date = datetime(year, month, 1)
        if month == 12:
            end_date = datetime(year + 1, 1, 1)
        else:
            end_date = datetime(year, month + 1, 1)
        
        partition_name = f"ledger_events_y{year}m{month:02d}"
        
        op.execute(f"""
            CREATE TABLE {partition_name} PARTITION OF ledger_events
            FOR VALUES FROM ('{start_date.isoformat()}') TO ('{end_date.isoformat()}');
        """)
        
        print(f"Created partition: {partition_name} ({start_date.date()} to {end_date.date()})")
    
    # Step 4: Copy data from old table to new partitioned table
    # This will automatically route data to appropriate partitions
    op.execute("""
        INSERT INTO ledger_events 
        SELECT * FROM ledger_events_old;
    """)
    
    # Step 5: Recreate indexes on partitioned table
    # Note: Indexes are created on source table and inherited by partitions
    op.create_index(
        'ix_ledger_events_principal_id', 
        'ledger_events', 
        ['principal_id'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_timestamp', 
        'ledger_events', 
        ['timestamp'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_agent_timestamp', 
        'ledger_events', 
        ['principal_id', 'timestamp'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_resource_type', 
        'ledger_events', 
        ['resource_type'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_provisional_charge_id', 
        'ledger_events', 
        ['provisional_charge_id'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_agent_resource_timestamp',
        'ledger_events',
        ['principal_id', 'resource_type', 'timestamp'],
        unique=False
    )
    
    # Step 6: Drop dependent objects then the old table, then recreate them
    # against the new partitioned table.
    
    # Drop materialized views (created in e4f5g6h7i8j9) that reference ledger_events_old
    op.execute("DROP MATERIALIZED VIEW IF EXISTS spending_by_agent_mv;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS spending_by_time_window_mv;")
    
    # Drop FK from provisional_charges → ledger_events_old
    op.execute("""
        ALTER TABLE provisional_charges
        DROP CONSTRAINT IF EXISTS provisional_charges_final_charge_event_id_fkey;
    """)
    
    # Now safe to drop the old table
    op.execute("DROP TABLE ledger_events_old;")
    
    # Note: The FK is NOT recreated against the partitioned table.
    # PostgreSQL requires a FK's referenced column to be a unique key or primary key.
    # The new partitioned table's PK is (event_id, timestamp) — referencing event_id
    # alone would require a separate unique constraint, which itself must include the
    # partition key on partitioned tables.  The referential integrity is enforced by
    # application logic (ORM) instead.
    
    # Recreate materialized views referencing new partitioned table
    op.execute("""
        CREATE MATERIALIZED VIEW spending_by_agent_mv AS
        SELECT
            principal_id,
            currency,
            SUM(cost) as total_spending,
            COUNT(*) as event_count,
            MIN(timestamp) as first_event_at,
            MAX(timestamp) as last_event_at,
            NOW() as refreshed_at
        FROM ledger_events
        GROUP BY principal_id, currency
        WITH DATA;
    """)
    op.execute("""
        CREATE UNIQUE INDEX ix_spending_by_agent_mv_agent_currency
        ON spending_by_agent_mv (principal_id, currency);
    """)
    op.execute("""
        CREATE MATERIALIZED VIEW spending_by_time_window_mv AS
        SELECT
            principal_id,
            currency,
            SUM(CASE WHEN timestamp >= NOW() - INTERVAL '1 hour'  THEN cost ELSE 0 END) as spending_last_hour,
            SUM(CASE WHEN timestamp >= NOW() - INTERVAL '1 day'   THEN cost ELSE 0 END) as spending_last_day,
            SUM(CASE WHEN timestamp >= NOW() - INTERVAL '7 days'  THEN cost ELSE 0 END) as spending_last_week,
            SUM(CASE WHEN timestamp >= NOW() - INTERVAL '30 days' THEN cost ELSE 0 END) as spending_last_month,
            SUM(CASE WHEN DATE(timestamp) = CURRENT_DATE             THEN cost ELSE 0 END) as spending_current_day,
            SUM(CASE WHEN timestamp >= DATE_TRUNC('week',  NOW())    THEN cost ELSE 0 END) as spending_current_week,
            SUM(CASE WHEN timestamp >= DATE_TRUNC('month', NOW())    THEN cost ELSE 0 END) as spending_current_month,
            COUNT(*) as total_events,
            NOW() as refreshed_at
        FROM ledger_events
        GROUP BY principal_id, currency
        WITH DATA;
    """)
    op.execute("""
        CREATE UNIQUE INDEX ix_spending_by_time_window_mv_agent_currency
        ON spending_by_time_window_mv (principal_id, currency);
    """)
    
    print("Successfully converted ledger_events to partitioned table")


def downgrade() -> None:
    """
    Downgrade schema to non-partitioned ledger_events table.
    
    WARNING: This will convert partitioned table back to regular table.
    """
    
    # Step 1: Create new non-partitioned table
    op.execute("""
        CREATE TABLE ledger_events_new (
            event_id BIGSERIAL PRIMARY KEY,
            principal_id UUID NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            resource_type VARCHAR(255) NOT NULL,
            quantity NUMERIC(20, 6) NOT NULL,
            cost NUMERIC(20, 6) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'USD',
            metadata JSONB,
            provisional_charge_id UUID,
            FOREIGN KEY (principal_id) REFERENCES principal_identities(principal_id)
        );
    """)
    
    # Step 2: Copy data from partitioned table
    op.execute("""
        INSERT INTO ledger_events_new 
        SELECT * FROM ledger_events;
    """)
    
    # Step 3: Drop partitioned table (this drops all partitions)
    op.execute("DROP TABLE ledger_events CASCADE;")
    
    # Step 4: Rename new table to original name
    op.execute("ALTER TABLE ledger_events_new RENAME TO ledger_events;")
    
    # Step 5: Recreate indexes
    op.create_index(
        'ix_ledger_events_principal_id', 
        'ledger_events', 
        ['principal_id'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_timestamp', 
        'ledger_events', 
        ['timestamp'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_agent_timestamp', 
        'ledger_events', 
        ['principal_id', 'timestamp'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_resource_type', 
        'ledger_events', 
        ['resource_type'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_provisional_charge_id', 
        'ledger_events', 
        ['provisional_charge_id'], 
        unique=False
    )
    op.create_index(
        'ix_ledger_events_agent_resource_timestamp',
        'ledger_events',
        ['principal_id', 'resource_type', 'timestamp'],
        unique=False
    )
    
    print("Successfully converted ledger_events back to non-partitioned table")
