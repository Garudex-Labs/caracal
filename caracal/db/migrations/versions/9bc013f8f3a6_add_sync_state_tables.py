"""add_sync_state_tables

Revision ID: 9bc013f8f3a6
Revises: j9k0l1m2n3o4
Create Date: 2026-03-25 16:05:35.107977

Adds PostgreSQL tables for sync state management:
- sync_operations: Queued operations for synchronization
- sync_conflicts: Detected conflicts during sync
- sync_metadata: Sync configuration and state per workspace

Includes indexes for efficient querying and PostgreSQL advisory locks
for distributed coordination.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


# revision identifiers, used by Alembic.
revision: str = '9bc013f8f3a6'
down_revision: Union[str, Sequence[str], None] = 'j9k0l1m2n3o4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema - add sync state tables."""
    
    # Create sync_operations table
    op.create_table(
        'sync_operations',
        sa.Column('operation_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('workspace', sa.String(64), nullable=False),
        sa.Column('operation_type', sa.String(20), nullable=False),
        sa.Column('entity_type', sa.String(100), nullable=False),
        sa.Column('entity_id', sa.String(255), nullable=False),
        sa.Column('operation_data', JSONB, nullable=False),
        sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('scheduled_at', sa.DateTime, nullable=True),
        sa.Column('retry_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('last_retry_at', sa.DateTime, nullable=True),
        sa.Column('last_error', sa.String(2000), nullable=True),
        sa.Column('max_retries', sa.Integer, nullable=False, server_default='5'),
        sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
        sa.Column('completed_at', sa.DateTime, nullable=True),
        sa.Column('metadata', JSONB, nullable=True),
        sa.Column('correlation_id', sa.String(255), nullable=True),
    )
    
    # Create indexes for sync_operations
    op.create_index('ix_sync_operations_workspace', 'sync_operations', ['workspace'])
    op.create_index('ix_sync_operations_operation_type', 'sync_operations', ['operation_type'])
    op.create_index('ix_sync_operations_entity_type', 'sync_operations', ['entity_type'])
    op.create_index('ix_sync_operations_entity_id', 'sync_operations', ['entity_id'])
    op.create_index('ix_sync_operations_created_at', 'sync_operations', ['created_at'])
    op.create_index('ix_sync_operations_scheduled_at', 'sync_operations', ['scheduled_at'])
    op.create_index('ix_sync_operations_status', 'sync_operations', ['status'])
    op.create_index('ix_sync_operations_correlation_id', 'sync_operations', ['correlation_id'])
    
    # Composite indexes for common queries
    op.create_index('ix_sync_operations_workspace_status', 'sync_operations', ['workspace', 'status'])
    op.create_index('ix_sync_operations_workspace_created', 'sync_operations', ['workspace', 'created_at'])
    op.create_index('ix_sync_operations_entity', 'sync_operations', ['entity_type', 'entity_id'])
    
    # Create sync_conflicts table
    op.create_table(
        'sync_conflicts',
        sa.Column('conflict_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('workspace', sa.String(64), nullable=False),
        sa.Column('entity_type', sa.String(100), nullable=False),
        sa.Column('entity_id', sa.String(255), nullable=False),
        sa.Column('local_version', JSONB, nullable=False),
        sa.Column('remote_version', JSONB, nullable=False),
        sa.Column('local_timestamp', sa.DateTime, nullable=False),
        sa.Column('remote_timestamp', sa.DateTime, nullable=False),
        sa.Column('detected_at', sa.DateTime, nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('resolution_strategy', sa.String(50), nullable=True),
        sa.Column('resolved_version', JSONB, nullable=True),
        sa.Column('resolved_at', sa.DateTime, nullable=True),
        sa.Column('resolved_by', sa.String(255), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='unresolved'),
        sa.Column('metadata', JSONB, nullable=True),
        sa.Column('correlation_id', sa.String(255), nullable=True),
    )
    
    # Create indexes for sync_conflicts
    op.create_index('ix_sync_conflicts_workspace', 'sync_conflicts', ['workspace'])
    op.create_index('ix_sync_conflicts_entity_type', 'sync_conflicts', ['entity_type'])
    op.create_index('ix_sync_conflicts_entity_id', 'sync_conflicts', ['entity_id'])
    op.create_index('ix_sync_conflicts_local_timestamp', 'sync_conflicts', ['local_timestamp'])
    op.create_index('ix_sync_conflicts_remote_timestamp', 'sync_conflicts', ['remote_timestamp'])
    op.create_index('ix_sync_conflicts_detected_at', 'sync_conflicts', ['detected_at'])
    op.create_index('ix_sync_conflicts_resolved_at', 'sync_conflicts', ['resolved_at'])
    op.create_index('ix_sync_conflicts_status', 'sync_conflicts', ['status'])
    op.create_index('ix_sync_conflicts_correlation_id', 'sync_conflicts', ['correlation_id'])
    
    # Composite indexes for common queries
    op.create_index('ix_sync_conflicts_workspace_status', 'sync_conflicts', ['workspace', 'status'])
    op.create_index('ix_sync_conflicts_workspace_detected', 'sync_conflicts', ['workspace', 'detected_at'])
    op.create_index('ix_sync_conflicts_entity', 'sync_conflicts', ['entity_type', 'entity_id'])
    
    # Create sync_metadata table
    op.create_table(
        'sync_metadata',
        sa.Column('workspace', sa.String(64), primary_key=True),
        sa.Column('remote_url', sa.String(2048), nullable=True),
        sa.Column('remote_version', sa.String(50), nullable=True),
        sa.Column('sync_enabled', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('last_sync_at', sa.DateTime, nullable=True),
        sa.Column('last_sync_direction', sa.String(20), nullable=True),
        sa.Column('last_sync_status', sa.String(20), nullable=True),
        sa.Column('total_operations_synced', sa.BigInteger, nullable=False, server_default='0'),
        sa.Column('total_conflicts_detected', sa.BigInteger, nullable=False, server_default='0'),
        sa.Column('total_conflicts_resolved', sa.BigInteger, nullable=False, server_default='0'),
        sa.Column('last_error', sa.String(2000), nullable=True),
        sa.Column('last_error_at', sa.DateTime, nullable=True),
        sa.Column('consecutive_failures', sa.Integer, nullable=False, server_default='0'),
        sa.Column('auto_sync_enabled', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('auto_sync_interval_seconds', sa.Integer, nullable=True),
        sa.Column('next_auto_sync_at', sa.DateTime, nullable=True),
        sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.DateTime, nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('metadata', JSONB, nullable=True),
    )
    
    # Create indexes for sync_metadata
    op.create_index('ix_sync_metadata_sync_enabled', 'sync_metadata', ['sync_enabled'])
    op.create_index('ix_sync_metadata_last_sync_at', 'sync_metadata', ['last_sync_at'])
    op.create_index('ix_sync_metadata_next_auto_sync_at', 'sync_metadata', ['next_auto_sync_at'])


def downgrade() -> None:
    """Downgrade schema - remove sync state tables."""
    
    # Drop sync_metadata table and indexes
    op.drop_index('ix_sync_metadata_next_auto_sync_at', 'sync_metadata')
    op.drop_index('ix_sync_metadata_last_sync_at', 'sync_metadata')
    op.drop_index('ix_sync_metadata_sync_enabled', 'sync_metadata')
    op.drop_table('sync_metadata')
    
    # Drop sync_conflicts table and indexes
    op.drop_index('ix_sync_conflicts_entity', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_workspace_detected', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_workspace_status', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_correlation_id', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_status', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_resolved_at', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_detected_at', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_remote_timestamp', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_local_timestamp', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_entity_id', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_entity_type', 'sync_conflicts')
    op.drop_index('ix_sync_conflicts_workspace', 'sync_conflicts')
    op.drop_table('sync_conflicts')
    
    # Drop sync_operations table and indexes
    op.drop_index('ix_sync_operations_entity', 'sync_operations')
    op.drop_index('ix_sync_operations_workspace_created', 'sync_operations')
    op.drop_index('ix_sync_operations_workspace_status', 'sync_operations')
    op.drop_index('ix_sync_operations_correlation_id', 'sync_operations')
    op.drop_index('ix_sync_operations_status', 'sync_operations')
    op.drop_index('ix_sync_operations_scheduled_at', 'sync_operations')
    op.drop_index('ix_sync_operations_created_at', 'sync_operations')
    op.drop_index('ix_sync_operations_entity_id', 'sync_operations')
    op.drop_index('ix_sync_operations_entity_type', 'sync_operations')
    op.drop_index('ix_sync_operations_operation_type', 'sync_operations')
    op.drop_index('ix_sync_operations_workspace', 'sync_operations')
    op.drop_table('sync_operations')
