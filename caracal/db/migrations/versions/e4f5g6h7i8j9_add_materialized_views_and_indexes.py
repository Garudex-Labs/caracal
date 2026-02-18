"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add materialized views and indexes for ledger query optimization

Revision ID: e4f5g6h7i8j9
Revises: d3e4f5g6h7i8
Create Date: 2026-02-03 10:00:00.000000

Creates materialized views and indexes for optimized ledger queries:
- spending_by_agent_mv: Aggregated spending per agent
- spending_by_time_window_mv: Aggregated spending by time windows
- Composite indexes on ledger_events for common query patterns
- Indexes on resource_type and provisional_charge_id

Requirements: 20.1, 20.2
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4f5g6h7i8j9'
down_revision: Union[str, Sequence[str], None] = 'd3e4f5g6h7i8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema with materialized views and indexes."""
    
    # Create materialized view for spending aggregations by agent
    # This view provides fast lookups for total spending per agent
    op.execute("""
        CREATE MATERIALIZED VIEW spending_by_agent_mv AS
        SELECT 
            agent_id,
            currency,
            SUM(cost) as total_spending,
  
          COUNT(*) as event_count,
            MIN(timestamp) as first_event_at,
            MAX(timestamp) as last_event_at,
            NOW() as refreshed_at
        FROM ledger_events
        GROUP BY agent_id, currency
        WITH DATA;
    """)
    
    # Create unique index on materialized view for concurrent refresh
    op.execute("""
        CREATE UNIQUE INDEX ix_spending_by_agent_mv_agent_currency 
        ON spending_by_agent_mv (agent_id, currency);
    """)
    
    # Create materialized view for spending by time windows
    # This view provides fast lookups for spending in different time windows
    op.execute("""
        CREATE MATERIALIZED VIEW spending_by_time_window_mv AS
        SELECT 
            agent_id,
            currency,
            -- Hourly aggregations (last 24 hours)
            SUM(CASE 
                WHEN timestamp >= NOW() - INTERVAL '1 hour' 
                THEN cost ELSE 0 
            END) as spending_last_hour,
            -- Daily aggregations (last 7 days)
            SUM(CASE 
                WHEN timestamp >= NOW() - INTERVAL '1 day' 
                THEN cost ELSE 0 
            END) as spending_last_day,
            -- Weekly aggregations (last 4 weeks)
            SUM(CASE 
                WHEN timestamp >= NOW() - INTERVAL '7 days' 
                THEN cost ELSE 0 
            END) as spending_last_week,
            -- Monthly aggregations (last 12 months)
            SUM(CASE 
                WHEN timestamp >= NOW() - INTERVAL '30 days' 
                THEN cost ELSE 0 
            END) as spending_last_month,
            -- Calendar day (current day)
            SUM(CASE 
                WHEN DATE(timestamp) = CURRENT_DATE 
                THEN cost ELSE 0 
            END) as spending_current_day,
            -- Calendar week (current week, Monday-Sunday)
            SUM(CASE 
                WHEN timestamp >= DATE_TRUNC('week', NOW()) 
                THEN cost ELSE 0 
            END) as spending_current_week,
            -- Calendar month (current month)
            SUM(CASE 
                WHEN timestamp >= DATE_TRUNC('month', NOW()) 
                THEN cost ELSE 0 
            END) as spending_current_month,
            COUNT(*) as total_events,
            NOW() as refreshed_at
        FROM ledger_events
        GROUP BY agent_id, currency
        WITH DATA;
    """)
    
    # Create unique index on time window materialized view for concurrent refresh
    op.execute("""
        CREATE UNIQUE INDEX ix_spending_by_time_window_mv_agent_currency 
        ON spending_by_time_window_mv (agent_id, currency);
    """)
    
    # Add composite index on (agent_id, timestamp) for time-range queries
    # This index is already created in the initial schema, but we ensure it exists
    # op.create_index('ix_ledger_events_agent_timestamp', 'ledger_events', ['agent_id', 'timestamp'], unique=False)
    
    # Add index on resource_type for filtering by resource
    op.create_index(
        'ix_ledger_events_resource_type', 
        'ledger_events', 
        ['resource_type'], 
        unique=False
    )
    
    # Add index on provisional_charge_id for lookups
    op.create_index(
        'ix_ledger_events_provisional_charge_id', 
        'ledger_events', 
        ['provisional_charge_id'], 
        unique=False
    )
    
    # Add composite index on (agent_id, resource_type, timestamp) for filtered queries
    op.create_index(
        'ix_ledger_events_agent_resource_timestamp',
        'ledger_events',
        ['agent_id', 'resource_type', 'timestamp'],
        unique=False
    )


def downgrade() -> None:
    """Downgrade schema by removing materialized views and indexes."""
    
    # Drop composite index
    op.drop_index('ix_ledger_events_agent_resource_timestamp', table_name='ledger_events')
    
    # Drop indexes on ledger_events
    op.drop_index('ix_ledger_events_provisional_charge_id', table_name='ledger_events')
    op.drop_index('ix_ledger_events_resource_type', table_name='ledger_events')
    
    # Drop materialized views (indexes are dropped automatically)
    op.execute("DROP MATERIALIZED VIEW IF EXISTS spending_by_time_window_mv;")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS spending_by_agent_mv;")
