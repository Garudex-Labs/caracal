"""Add resource_allowlists table

Revision ID: c2d3e4f5g6h7
Revises: b1c2d3e4f5g6
Create Date: 2026-02-03 12:00:00.000000

Adds resource_allowlists table for fine-grained access control (v0.3):
- Stores whitelist patterns (regex or glob) for resource access
- Enables per-agent resource restrictions
- Supports both regex and glob pattern matching
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c2d3e4f5g6h7'
down_revision: Union[str, Sequence[str], None] = 'b1c2d3e4f5g6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema to add resource_allowlists table."""
    
    # Create resource_allowlists table
    op.create_table(
        'resource_allowlists',
        sa.Column('allowlist_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('resource_pattern', sa.String(length=1000), nullable=False),
        sa.Column('pattern_type', sa.String(length=10), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['agent_id'], ['agent_identities.agent_id'], ),
        sa.PrimaryKeyConstraint('allowlist_id')
    )
    
    # Create indexes
    op.create_index(op.f('ix_resource_allowlists_agent_id'), 'resource_allowlists', ['agent_id'], unique=False)
    op.create_index('ix_resource_allowlists_agent_active', 'resource_allowlists', ['agent_id', 'active'], unique=False)


def downgrade() -> None:
    """Downgrade schema to remove resource_allowlists table."""
    
    # Drop indexes
    op.drop_index('ix_resource_allowlists_agent_active', table_name='resource_allowlists')
    op.drop_index(op.f('ix_resource_allowlists_agent_id'), table_name='resource_allowlists')
    
    # Drop table
    op.drop_table('resource_allowlists')
