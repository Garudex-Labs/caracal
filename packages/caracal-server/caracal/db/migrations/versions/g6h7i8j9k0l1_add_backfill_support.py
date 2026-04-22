"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

add backfill support

Revision ID: g6h7i8j9k0l1
Revises: f5g6h7i8j9k0
Create Date: 2026-02-03 12:00:00.000000

Add database schema changes to support v0.2 ledger backfill:
- Add source column to merkle_roots table (VARCHAR(50), default 'live')
- Add merkle_root_id column to ledger_events table (UUID, nullable)
- Create index on ledger_events(merkle_root_id)

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'g6h7i8j9k0l1'
down_revision = 'f5g6h7i8j9k0'
branch_labels = None
depends_on = None


def upgrade():
    """Apply migration: add backfill support columns."""
    
    # Add source column to merkle_roots table
    op.add_column(
        'merkle_roots',
        sa.Column(
            'source',
            sa.String(length=50),
            nullable=False,
            server_default='live',
            comment='Source of the batch: "live" for real-time batches, "migration" for backfilled v0.2 events'
        )
    )
    
    # Add merkle_root_id column to ledger_events table (nullable for backward compatibility)
    op.add_column(
        'ledger_events',
        sa.Column(
            'merkle_root_id',
            postgresql.UUID(as_uuid=True),
            nullable=True,
            comment='Foreign key to merkle_roots table, NULL for events not yet batched'
        )
    )
    
    # Create foreign key constraint
    op.create_foreign_key(
        'fk_ledger_events_merkle_root_id',
        'ledger_events',
        'merkle_roots',
        ['merkle_root_id'],
        ['root_id'],
        ondelete='SET NULL'
    )
    
    # Create index on ledger_events(merkle_root_id) for efficient batch queries
    op.create_index(
        'ix_ledger_events_merkle_root_id',
        'ledger_events',
        ['merkle_root_id']
    )
    
    # Create index on merkle_roots(source) for filtering migration batches
    op.create_index(
        'ix_merkle_roots_source',
        'merkle_roots',
        ['source']
    )


def downgrade():
    """Revert migration: remove backfill support columns."""
    
    # Drop indexes
    op.drop_index('ix_merkle_roots_source', table_name='merkle_roots')
    op.drop_index('ix_ledger_events_merkle_root_id', table_name='ledger_events')
    
    # Drop foreign key constraint
    op.drop_constraint('fk_ledger_events_merkle_root_id', 'ledger_events', type_='foreignkey')
    
    # Drop columns
    op.drop_column('ledger_events', 'merkle_root_id')
    op.drop_column('merkle_roots', 'source')
