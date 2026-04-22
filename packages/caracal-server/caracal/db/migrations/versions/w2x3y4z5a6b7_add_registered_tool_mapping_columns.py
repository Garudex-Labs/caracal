"""Add provider/action/resource mapping columns to registered_tools.

Revision ID: w2x3y4z5a6b7
Revises: v1w2x3y4z5a6
Create Date: 2026-04-08 13:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "w2x3y4z5a6b7"
down_revision: Union[str, Sequence[str], None] = "v1w2x3y4z5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = inspector.get_columns(table_name)
    return any(column.get("name") == column_name for column in columns)


def _has_index(table_name: str, index_name: str) -> bool:
    if not _has_table(table_name):
        return False

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_column("registered_tools", "provider_name"):
        op.add_column("registered_tools", sa.Column("provider_name", sa.String(length=255), nullable=True))

    if not _has_column("registered_tools", "resource_scope"):
        op.add_column("registered_tools", sa.Column("resource_scope", sa.String(length=255), nullable=True))

    if not _has_column("registered_tools", "action_scope"):
        op.add_column("registered_tools", sa.Column("action_scope", sa.String(length=255), nullable=True))

    if not _has_column("registered_tools", "provider_definition_id"):
        op.add_column(
            "registered_tools",
            sa.Column("provider_definition_id", sa.String(length=255), nullable=True),
        )

    if not _has_index("registered_tools", "ix_registered_tools_provider_name"):
        op.create_index(
            "ix_registered_tools_provider_name",
            "registered_tools",
            ["provider_name"],
            unique=False,
        )


def downgrade() -> None:
    if _has_index("registered_tools", "ix_registered_tools_provider_name"):
        op.drop_index("ix_registered_tools_provider_name", table_name="registered_tools")

    if _has_column("registered_tools", "provider_definition_id"):
        op.drop_column("registered_tools", "provider_definition_id")

    if _has_column("registered_tools", "action_scope"):
        op.drop_column("registered_tools", "action_scope")

    if _has_column("registered_tools", "resource_scope"):
        op.drop_column("registered_tools", "resource_scope")

    if _has_column("registered_tools", "provider_name"):
        op.drop_column("registered_tools", "provider_name")
