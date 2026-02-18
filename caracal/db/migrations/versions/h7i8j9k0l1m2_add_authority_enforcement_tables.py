"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add authority enforcement tables

Revision ID: h7i8j9k0l1m2
Revises: g6h7i8j9k0l1
Create Date: 2026-02-09 10:00:00.000000

Adds authority enforcement tables for v0.5.0 transformation:
- principals: Principal identity (agent, user, service)
- execution_mandates: Cryptographically signed execution authorizations
- authority_ledger_events: Immutable authority decision log
- authority_policies: Mandate issuance constraints

Preserves existing tables for backward compatibility during migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'h7i8j9k0l1m2'
down_revision: Union[str, Sequence[str], None] = 'g6h7i8j9k0l1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema to add authority enforcement tables."""
    
    # Create principals table
    op.create_table(
        'principals',
        sa.Column('principal_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('principal_type', sa.String(length=50), nullable=False),
        sa.Column('owner', sa.String(length=255), nullable=False),
        sa.Column('parent_principal_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('public_key_pem', sa.String(length=2000), nullable=True),
        sa.Column('private_key_pem', sa.String(length=4000), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(['parent_principal_id'], ['principals.principal_id'], ),
        sa.PrimaryKeyConstraint('principal_id'),
        sa.UniqueConstraint('name')
    )
    
    # Create indexes for principals
    op.create_index(op.f('ix_principals_name'), 'principals', ['name'], unique=True)
    op.create_index(op.f('ix_principals_principal_type'), 'principals', ['principal_type'], unique=False)
    op.create_index(op.f('ix_principals_parent_principal_id'), 'principals', ['parent_principal_id'], unique=False)
    
    # Create execution_mandates table
    op.create_table(
        'execution_mandates',
        sa.Column('mandate_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('issuer_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('subject_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('valid_from', sa.DateTime(), nullable=False),
        sa.Column('valid_until', sa.DateTime(), nullable=False),
        sa.Column('resource_scope', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('action_scope', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('signature', sa.String(length=512), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('revoked', sa.Boolean(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('revocation_reason', sa.String(length=1000), nullable=True),
        sa.Column('parent_mandate_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('delegation_depth', sa.Integer(), nullable=False),
        sa.Column('intent_hash', sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(['issuer_id'], ['principals.principal_id'], ),
        sa.ForeignKeyConstraint(['subject_id'], ['principals.principal_id'], ),
        sa.ForeignKeyConstraint(['parent_mandate_id'], ['execution_mandates.mandate_id'], ),
        sa.PrimaryKeyConstraint('mandate_id')
    )
    
    # Create indexes for execution_mandates
    op.create_index(op.f('ix_execution_mandates_issuer_id'), 'execution_mandates', ['issuer_id'], unique=False)
    op.create_index(op.f('ix_execution_mandates_subject_id'), 'execution_mandates', ['subject_id'], unique=False)
    op.create_index(op.f('ix_execution_mandates_valid_from'), 'execution_mandates', ['valid_from'], unique=False)
    op.create_index(op.f('ix_execution_mandates_valid_until'), 'execution_mandates', ['valid_until'], unique=False)
    op.create_index(op.f('ix_execution_mandates_revoked'), 'execution_mandates', ['revoked'], unique=False)
    op.create_index(op.f('ix_execution_mandates_parent_mandate_id'), 'execution_mandates', ['parent_mandate_id'], unique=False)
    
    # Create authority_ledger_events table
    op.create_table(
        'authority_ledger_events',
        sa.Column('event_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('event_type', sa.String(length=50), nullable=False),
        sa.Column('timestamp', sa.DateTime(), nullable=False),
        sa.Column('principal_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('mandate_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('decision', sa.String(length=20), nullable=True),
        sa.Column('denial_reason', sa.String(length=1000), nullable=True),
        sa.Column('requested_action', sa.String(length=255), nullable=True),
        sa.Column('requested_resource', sa.String(length=1000), nullable=True),
        sa.Column('event_metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('correlation_id', sa.String(length=255), nullable=True),
        sa.Column('merkle_root_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(['principal_id'], ['principals.principal_id'], ),
        sa.ForeignKeyConstraint(['mandate_id'], ['execution_mandates.mandate_id'], ),
        sa.ForeignKeyConstraint(['merkle_root_id'], ['merkle_roots.root_id'], ),
        sa.PrimaryKeyConstraint('event_id')
    )
    
    # Create indexes for authority_ledger_events
    op.create_index(op.f('ix_authority_ledger_events_event_type'), 'authority_ledger_events', ['event_type'], unique=False)
    op.create_index(op.f('ix_authority_ledger_events_timestamp'), 'authority_ledger_events', ['timestamp'], unique=False)
    op.create_index(op.f('ix_authority_ledger_events_principal_id'), 'authority_ledger_events', ['principal_id'], unique=False)
    op.create_index(op.f('ix_authority_ledger_events_mandate_id'), 'authority_ledger_events', ['mandate_id'], unique=False)
    op.create_index(op.f('ix_authority_ledger_events_correlation_id'), 'authority_ledger_events', ['correlation_id'], unique=False)
    op.create_index(op.f('ix_authority_ledger_events_merkle_root_id'), 'authority_ledger_events', ['merkle_root_id'], unique=False)
    op.create_index('ix_authority_ledger_events_principal_timestamp', 'authority_ledger_events', ['principal_id', 'timestamp'], unique=False)
    op.create_index('ix_authority_ledger_events_mandate_timestamp', 'authority_ledger_events', ['mandate_id', 'timestamp'], unique=False)
    
    # Create authority_policies table
    op.create_table(
        'authority_policies',
        sa.Column('policy_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('principal_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('max_validity_seconds', sa.Integer(), nullable=False),
        sa.Column('allowed_resource_patterns', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('allowed_actions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('allow_delegation', sa.Boolean(), nullable=False),
        sa.Column('max_delegation_depth', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('created_by', sa.String(length=255), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['principal_id'], ['principals.principal_id'], ),
        sa.PrimaryKeyConstraint('policy_id')
    )
    
    # Create indexes for authority_policies
    op.create_index(op.f('ix_authority_policies_principal_id'), 'authority_policies', ['principal_id'], unique=False)
    op.create_index(op.f('ix_authority_policies_active'), 'authority_policies', ['active'], unique=False)
    op.create_index('ix_authority_policies_principal_active', 'authority_policies', ['principal_id', 'active'], unique=False)


def downgrade() -> None:
    """Downgrade schema to remove authority enforcement tables."""
    
    # Drop authority_policies table and indexes
    op.drop_index('ix_authority_policies_principal_active', table_name='authority_policies')
    op.drop_index(op.f('ix_authority_policies_active'), table_name='authority_policies')
    op.drop_index(op.f('ix_authority_policies_principal_id'), table_name='authority_policies')
    op.drop_table('authority_policies')
    
    # Drop authority_ledger_events table and indexes
    op.drop_index('ix_authority_ledger_events_mandate_timestamp', table_name='authority_ledger_events')
    op.drop_index('ix_authority_ledger_events_principal_timestamp', table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_merkle_root_id'), table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_correlation_id'), table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_mandate_id'), table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_principal_id'), table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_timestamp'), table_name='authority_ledger_events')
    op.drop_index(op.f('ix_authority_ledger_events_event_type'), table_name='authority_ledger_events')
    op.drop_table('authority_ledger_events')
    
    # Drop execution_mandates table and indexes
    op.drop_index(op.f('ix_execution_mandates_parent_mandate_id'), table_name='execution_mandates')
    op.drop_index(op.f('ix_execution_mandates_revoked'), table_name='execution_mandates')
    op.drop_index(op.f('ix_execution_mandates_valid_until'), table_name='execution_mandates')
    op.drop_index(op.f('ix_execution_mandates_valid_from'), table_name='execution_mandates')
    op.drop_index(op.f('ix_execution_mandates_subject_id'), table_name='execution_mandates')
    op.drop_index(op.f('ix_execution_mandates_issuer_id'), table_name='execution_mandates')
    op.drop_table('execution_mandates')
    
    # Drop principals table and indexes
    op.drop_index(op.f('ix_principals_parent_principal_id'), table_name='principals')
    op.drop_index(op.f('ix_principals_principal_type'), table_name='principals')
    op.drop_index(op.f('ix_principals_name'), table_name='principals')
    op.drop_table('principals')
