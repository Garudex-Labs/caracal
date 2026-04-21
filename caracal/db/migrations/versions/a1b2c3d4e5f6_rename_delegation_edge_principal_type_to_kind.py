"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Rename delegation_edges principal_type columns to principal_kind.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "z5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    columns = [c["name"] for c in inspector.get_columns(table_name)]
    return column_name in columns


def _has_index(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    indexes = inspector.get_indexes(table_name)
    return any(idx["name"] == index_name for idx in indexes)


def upgrade() -> None:
    if not _has_column("delegation_edges", "source_principal_type"):
        return

    op.drop_index(
        "ix_delegation_edges_source_principal_type",
        table_name="delegation_edges",
        if_exists=True,
    )
    op.drop_index(
        "ix_delegation_edges_target_principal_type",
        table_name="delegation_edges",
        if_exists=True,
    )
    if _has_index("delegation_edges", "ix_delegation_edges_types"):
        op.drop_index("ix_delegation_edges_types", table_name="delegation_edges")

    op.alter_column(
        "delegation_edges",
        "source_principal_type",
        new_column_name="source_principal_kind",
    )
    op.alter_column(
        "delegation_edges",
        "target_principal_type",
        new_column_name="target_principal_kind",
    )

    op.create_index(
        "ix_delegation_edges_source_principal_kind",
        "delegation_edges",
        ["source_principal_kind"],
    )
    op.create_index(
        "ix_delegation_edges_target_principal_kind",
        "delegation_edges",
        ["target_principal_kind"],
    )
    op.create_index(
        "ix_delegation_edges_types",
        "delegation_edges",
        ["source_principal_kind", "target_principal_kind"],
    )


def downgrade() -> None:
    if not _has_column("delegation_edges", "source_principal_kind"):
        return

    op.drop_index(
        "ix_delegation_edges_source_principal_kind",
        table_name="delegation_edges",
        if_exists=True,
    )
    op.drop_index(
        "ix_delegation_edges_target_principal_kind",
        table_name="delegation_edges",
        if_exists=True,
    )
    if _has_index("delegation_edges", "ix_delegation_edges_types"):
        op.drop_index("ix_delegation_edges_types", table_name="delegation_edges")

    op.alter_column(
        "delegation_edges",
        "source_principal_kind",
        new_column_name="source_principal_type",
    )
    op.alter_column(
        "delegation_edges",
        "target_principal_kind",
        new_column_name="target_principal_type",
    )

    op.create_index(
        "ix_delegation_edges_source_principal_type",
        "delegation_edges",
        ["source_principal_type"],
    )
    op.create_index(
        "ix_delegation_edges_target_principal_type",
        "delegation_edges",
        ["target_principal_type"],
    )
    op.create_index(
        "ix_delegation_edges_types",
        "delegation_edges",
        ["source_principal_type", "target_principal_type"],
    )
