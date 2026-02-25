"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Add parent_mandate_id and delegation_depth columns to execution_mandates

Revision ID: j9k0l1m2n3o4
Revises: i8j9k0l1m2n3
Create Date: 2026-02-25 00:00:00.000000

Changes:
- execution_mandates: add parent_mandate_id (UUID, FK to self, nullable)
                       add delegation_depth (INTEGER, nullable, default 0)

These columns were defined in the initial h7i8j9k0l1m2 migration's CREATE
TABLE but were missing from the SQLAlchemy ORM model.  Databases that were
bootstrapped via ``Base.metadata.create_all()`` instead of Alembic will not
have them.  This migration adds the columns idempotently.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy import inspect as sa_inspect


# revision identifiers, used by Alembic.
revision: str = 'j9k0l1m2n3o4'
down_revision: Union[str, Sequence[str], None] = 'i8j9k0l1m2n3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    """Check whether *column* already exists on *table*."""
    bind = op.get_bind()
    inspector = sa_inspect(bind)
    columns = [c["name"] for c in inspector.get_columns(table)]
    return column in columns


def upgrade() -> None:
    if not _column_exists("execution_mandates", "parent_mandate_id"):
        op.add_column(
            "execution_mandates",
            sa.Column(
                "parent_mandate_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("execution_mandates.mandate_id"),
                nullable=True,
            ),
        )
        op.create_index(
            "ix_execution_mandates_parent_mandate_id",
            "execution_mandates",
            ["parent_mandate_id"],
        )

    if not _column_exists("execution_mandates", "delegation_depth"):
        op.add_column(
            "execution_mandates",
            sa.Column(
                "delegation_depth",
                sa.Integer(),
                nullable=True,
                server_default="0",
            ),
        )


def downgrade() -> None:
    op.drop_index(
        "ix_execution_mandates_parent_mandate_id",
        table_name="execution_mandates",
    )
    op.drop_column("execution_mandates", "delegation_depth")
    op.drop_column("execution_mandates", "parent_mandate_id")
