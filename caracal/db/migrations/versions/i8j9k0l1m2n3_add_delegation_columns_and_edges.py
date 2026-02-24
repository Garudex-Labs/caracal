"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add delegation columns to execution_mandates and create delegation_edges table

Revision ID: i8j9k0l1m2n3
Revises: h7i8j9k0l1m2
Create Date: 2026-02-24 00:00:00.000000

Changes:
- execution_mandates: add delegation_type (VARCHAR 50, default 'hierarchical')
                       add context_tags (JSONB, nullable)
- delegation_edges: new table for directed authority delegation graph
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'i8j9k0l1m2n3'
down_revision: Union[str, Sequence[str], None] = 'h7i8j9k0l1m2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add delegation_type and context_tags to execution_mandates; create delegation_edges."""

    # ── execution_mandates additions ───────────────────────────────────────
    op.add_column(
        'execution_mandates',
        sa.Column(
            'delegation_type',
            sa.String(length=50),
            nullable=False,
            server_default='hierarchical',
        ),
    )
    op.add_column(
        'execution_mandates',
        sa.Column(
            'context_tags',
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )

    # ── delegation_edges table ─────────────────────────────────────────────
    op.create_table(
        'delegation_edges',
        sa.Column('edge_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('source_mandate_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('target_mandate_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('source_principal_type', sa.String(length=50), nullable=False),
        sa.Column('target_principal_type', sa.String(length=50), nullable=False),
        sa.Column('delegation_type', sa.String(length=50), nullable=False),
        sa.Column('context_tags', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('granted_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('revoked', sa.Boolean(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(
            ['source_mandate_id'],
            ['execution_mandates.mandate_id'],
        ),
        sa.ForeignKeyConstraint(
            ['target_mandate_id'],
            ['execution_mandates.mandate_id'],
        ),
        sa.PrimaryKeyConstraint('edge_id'),
    )

    op.create_index(
        'ix_delegation_edges_source_target',
        'delegation_edges',
        ['source_mandate_id', 'target_mandate_id'],
    )
    op.create_index(
        'ix_delegation_edges_types',
        'delegation_edges',
        ['source_principal_type', 'target_principal_type'],
    )
    op.create_index(
        op.f('ix_delegation_edges_source_mandate_id'),
        'delegation_edges',
        ['source_mandate_id'],
    )
    op.create_index(
        op.f('ix_delegation_edges_target_mandate_id'),
        'delegation_edges',
        ['target_mandate_id'],
    )
    op.create_index(
        op.f('ix_delegation_edges_source_principal_type'),
        'delegation_edges',
        ['source_principal_type'],
    )
    op.create_index(
        op.f('ix_delegation_edges_target_principal_type'),
        'delegation_edges',
        ['target_principal_type'],
    )
    op.create_index(
        op.f('ix_delegation_edges_revoked'),
        'delegation_edges',
        ['revoked'],
    )


def downgrade() -> None:
    """Remove delegation columns from execution_mandates; drop delegation_edges."""

    # Drop delegation_edges table and indexes
    op.drop_index(op.f('ix_delegation_edges_revoked'), table_name='delegation_edges')
    op.drop_index(op.f('ix_delegation_edges_target_principal_type'), table_name='delegation_edges')
    op.drop_index(op.f('ix_delegation_edges_source_principal_type'), table_name='delegation_edges')
    op.drop_index(op.f('ix_delegation_edges_target_mandate_id'), table_name='delegation_edges')
    op.drop_index(op.f('ix_delegation_edges_source_mandate_id'), table_name='delegation_edges')
    op.drop_index('ix_delegation_edges_types', table_name='delegation_edges')
    op.drop_index('ix_delegation_edges_source_target', table_name='delegation_edges')
    op.drop_table('delegation_edges')

    # Remove columns from execution_mandates
    op.drop_column('execution_mandates', 'context_tags')
    op.drop_column('execution_mandates', 'delegation_type')
