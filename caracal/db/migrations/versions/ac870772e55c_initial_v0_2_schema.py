"""Initial v0.2 schema

Revision ID: ac870772e55c
Revises: 
Create Date: 2026-02-01 23:03:52.248700

Creates the initial PostgreSQL schema for Caracal Core v0.2:
- agent_identities: Agent registry with parent-child relationships
- budget_policies: Budget policies with delegation tracking
- ledger_events: Immutable ledger events for spending tracking
- provisional_charges: Budget reservations with automatic expiration
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'ac870772e55c'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema to v0.2."""
    
    # Create agent_identities table
    op.create_table(
        'agent_identities',
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('owner', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('parent_agent_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('api_key_hash', sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(['parent_agent_id'], ['agent_identities.agent_id'], ),
        sa.PrimaryKeyConstraint('agent_id'),
        sa.UniqueConstraint('name')
    )
    op.create_index(op.f('ix_agent_identities_name'), 'agent_identities', ['name'], unique=False)
    op.create_index(op.f('ix_agent_identities_parent_agent_id'), 'agent_identities', ['parent_agent_id'], unique=False)
    
    # Create budget_policies table
    op.create_table(
        'budget_policies',
        sa.Column('policy_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('limit_amount', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('time_window', sa.String(length=50), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('delegated_from_agent_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['agent_id'], ['agent_identities.agent_id'], ),
        sa.ForeignKeyConstraint(['delegated_from_agent_id'], ['agent_identities.agent_id'], ),
        sa.PrimaryKeyConstraint('policy_id')
    )
    op.create_index('ix_budget_policies_agent_active', 'budget_policies', ['agent_id', 'active'], unique=False)
    op.create_index(op.f('ix_budget_policies_agent_id'), 'budget_policies', ['agent_id'], unique=False)
    
    # Create ledger_events table
    op.create_table(
        'ledger_events',
        sa.Column('event_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('timestamp', sa.DateTime(), nullable=False),
        sa.Column('resource_type', sa.String(length=255), nullable=False),
        sa.Column('quantity', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('cost', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('provisional_charge_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(['agent_id'], ['agent_identities.agent_id'], ),
        sa.PrimaryKeyConstraint('event_id')
    )
    op.create_index('ix_ledger_events_agent_timestamp', 'ledger_events', ['agent_id', 'timestamp'], unique=False)
    op.create_index(op.f('ix_ledger_events_agent_id'), 'ledger_events', ['agent_id'], unique=False)
    op.create_index(op.f('ix_ledger_events_timestamp'), 'ledger_events', ['timestamp'], unique=False)
    
    # Create provisional_charges table
    op.create_table(
        'provisional_charges',
        sa.Column('charge_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('agent_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('amount', sa.Numeric(precision=20, scale=6), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('released', sa.Boolean(), nullable=False),
        sa.Column('final_charge_event_id', sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(['agent_id'], ['agent_identities.agent_id'], ),
        sa.ForeignKeyConstraint(['final_charge_event_id'], ['ledger_events.event_id'], ),
        sa.PrimaryKeyConstraint('charge_id')
    )
    op.create_index('ix_provisional_charges_agent_released', 'provisional_charges', ['agent_id', 'released'], unique=False)
    op.create_index(op.f('ix_provisional_charges_agent_id'), 'provisional_charges', ['agent_id'], unique=False)
    op.create_index('ix_provisional_charges_expires_released', 'provisional_charges', ['expires_at', 'released'], unique=False)
    op.create_index(op.f('ix_provisional_charges_expires_at'), 'provisional_charges', ['expires_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema from v0.2."""
    
    # Drop tables in reverse order (respecting foreign keys)
    op.drop_index(op.f('ix_provisional_charges_expires_at'), table_name='provisional_charges')
    op.drop_index('ix_provisional_charges_expires_released', table_name='provisional_charges')
    op.drop_index(op.f('ix_provisional_charges_agent_id'), table_name='provisional_charges')
    op.drop_index('ix_provisional_charges_agent_released', table_name='provisional_charges')
    op.drop_table('provisional_charges')
    
    op.drop_index(op.f('ix_ledger_events_timestamp'), table_name='ledger_events')
    op.drop_index(op.f('ix_ledger_events_agent_id'), table_name='ledger_events')
    op.drop_index('ix_ledger_events_agent_timestamp', table_name='ledger_events')
    op.drop_table('ledger_events')
    
    op.drop_index(op.f('ix_budget_policies_agent_id'), table_name='budget_policies')
    op.drop_index('ix_budget_policies_agent_active', table_name='budget_policies')
    op.drop_table('budget_policies')
    
    op.drop_index(op.f('ix_agent_identities_parent_agent_id'), table_name='agent_identities')
    op.drop_index(op.f('ix_agent_identities_name'), table_name='agent_identities')
    op.drop_table('agent_identities')
