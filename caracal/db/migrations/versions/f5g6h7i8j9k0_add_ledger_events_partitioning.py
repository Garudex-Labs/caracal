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
import sqlalchemy as sa


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
    
    # Step 2: Create new partitioned table with same structure
    op.execute("""
        CREATE TABLE ledger_events (
            event_id BIGSERIAL,
            agent_id UUID NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            resource_type VARCHAR(255) NOT NULL,
            quantity NUMERIC(20, 6) NOT NULL,
            cost NUMERIC(20, 6) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'USD',
            metadata JSONB,
            provisional_charge_id UUID,
            PRIMARY KEY (event_id, timestamp),
            FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
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
    # Note: Indexes are created on parent table and inherited by partitions
    op.create_index(
        'ix_ledger_events_agent_id', 
        'ledger_events', 
        ['agent_id'], 
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
        ['agent_id', 'timestamp'], 
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
        ['agent_id', 'resource_type', 'timestamp'],
        unique=False
    )
    
    # Step 6: Drop old table
    op.execute("DROP TABLE ledger_events_old;")
    
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
            agent_id UUID NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            resource_type VARCHAR(255) NOT NULL,
            quantity NUMERIC(20, 6) NOT NULL,
            cost NUMERIC(20, 6) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'USD',
            metadata JSONB,
            provisional_charge_id UUID,
            FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
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
        'ix_ledger_events_agent_id', 
        'ledger_events', 
        ['agent_id'], 
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
        ['agent_id', 'timestamp'], 
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
        ['agent_id', 'resource_type', 'timestamp'],
        unique=False
    )
    
    print("Successfully converted ledger_events back to non-partitioned table")
