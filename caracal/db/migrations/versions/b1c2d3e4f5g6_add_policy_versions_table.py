"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add policy_versions table

Revision ID: b1c2d3e4f5g6
Revises: ac870772e55c
Create Date: 2026-02-03 10:00:00.000000

Adds policy_versions table for policy versioning and audit trails (v0.3):
- Stores immutable snapshots of policy changes
- Tracks who changed what and when
- Enables complete audit trail of policy modifications
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5g6'
down_revision: Union[str, Sequence[str], None] = 'ac870772e55c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema to add policy_versions table."""
    
    # Create policy_versions table
    op.create_table(
        'policy_versions',
        sa.Column('version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('policy_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('version_number', sa.BigInteger(), nullable=False),
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('limit_amount', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('time_window', sa.String(length=50), nullable=False),
        sa.Column('window_type', sa.String(length=50), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.Column('delegated_from_agent_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('change_type', sa.String(length=50), nullable=False),
        sa.Column('changed_by', sa.String(length=255), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
        sa.Column('change_reason', sa.String(length=1000), nullable=False),
        sa.ForeignKeyConstraint(['policy_id'], ['budget_policies.policy_id'], ),
        sa.PrimaryKeyConstraint('version_id')
    )
    
    # Create indexes
    op.create_index(op.f('ix_policy_versions_policy_id'), 'policy_versions', ['policy_id'], unique=False)
    op.create_index(op.f('ix_policy_versions_agent_id'), 'policy_versions', ['agent_id'], unique=False)
    op.create_index(op.f('ix_policy_versions_changed_at'), 'policy_versions', ['changed_at'], unique=False)
    op.create_index('ix_policy_versions_policy_version', 'policy_versions', ['policy_id', 'version_number'], unique=True)
    op.create_index('ix_policy_versions_agent_changed', 'policy_versions', ['agent_id', 'changed_at'], unique=False)
    op.create_index('ix_policy_versions_type_changed', 'policy_versions', ['change_type', 'changed_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema to remove policy_versions table."""
    
    # Drop indexes
    op.drop_index('ix_policy_versions_type_changed', table_name='policy_versions')
    op.drop_index('ix_policy_versions_agent_changed', table_name='policy_versions')
    op.drop_index('ix_policy_versions_policy_version', table_name='policy_versions')
    op.drop_index(op.f('ix_policy_versions_changed_at'), table_name='policy_versions')
    op.drop_index(op.f('ix_policy_versions_agent_id'), table_name='policy_versions')
    op.drop_index(op.f('ix_policy_versions_policy_id'), table_name='policy_versions')
    
    # Drop table
    op.drop_table('policy_versions')
