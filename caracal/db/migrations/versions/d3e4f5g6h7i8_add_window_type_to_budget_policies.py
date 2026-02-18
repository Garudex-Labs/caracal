"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

add window_type to budget_policies

Revision ID: d3e4f5g6h7i8
Revises: c2d3e4f5g6h7
Create Date: 2024-01-15 10:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd3e4f5g6h7i8'
down_revision = 'c2d3e4f5g6h7'
branch_labels = None
depends_on = None


def upgrade():
    """
    Add window_type column to budget_policies table.
    
    This migration adds support for extended time windows (v0.3):
    - Adds window_type column (rolling or calendar)
    - Sets default to 'calendar' for backward compatibility
    - Updates time_window to support hourly, daily, weekly, monthly
    
    Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.7
    """
    # Add window_type column with default 'calendar' for backward compatibility
    op.add_column('budget_policies', 
        sa.Column('window_type', sa.String(length=20), nullable=False, server_default='calendar')
    )
    
    # Note: time_window column already exists and supports various values
    # No schema change needed, just validation in application code


def downgrade():
    """Remove window_type column from budget_policies table."""
    op.drop_column('budget_policies', 'window_type')
