"""Add binding-contract fields to registered_tools.

Revision ID: y4z5a6b7c8d9
Revises: x3y4z5a6b7c8
Create Date: 2026-04-09 16:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "y4z5a6b7c8d9"
down_revision: Union[str, Sequence[str], None] = "x3y4z5a6b7c8"
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
    if not _has_column("registered_tools", "workspace_name"):
        op.add_column(
            "registered_tools",
            sa.Column("workspace_name", sa.String(length=255), nullable=True),
        )

    if not _has_column("registered_tools", "tool_type"):
        op.add_column(
            "registered_tools",
            sa.Column(
                "tool_type",
                sa.String(length=32),
                nullable=False,
                server_default="direct_api",
            ),
        )

    if not _has_column("registered_tools", "handler_ref"):
        op.add_column(
            "registered_tools",
            sa.Column("handler_ref", sa.String(length=512), nullable=True),
        )

    if not _has_column("registered_tools", "mapping_version"):
        op.add_column(
            "registered_tools",
            sa.Column("mapping_version", sa.String(length=128), nullable=True),
        )

    if not _has_column("registered_tools", "allowed_downstream_scopes"):
        op.add_column(
            "registered_tools",
            sa.Column(
                "allowed_downstream_scopes",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )

    if not _has_index("registered_tools", "ix_registered_tools_workspace_name"):
        op.create_index(
            "ix_registered_tools_workspace_name",
            "registered_tools",
            ["workspace_name"],
            unique=False,
        )


def downgrade() -> None:
    if _has_index("registered_tools", "ix_registered_tools_workspace_name"):
        op.drop_index("ix_registered_tools_workspace_name", table_name="registered_tools")

    if _has_column("registered_tools", "allowed_downstream_scopes"):
        op.drop_column("registered_tools", "allowed_downstream_scopes")

    if _has_column("registered_tools", "mapping_version"):
        op.drop_column("registered_tools", "mapping_version")

    if _has_column("registered_tools", "handler_ref"):
        op.drop_column("registered_tools", "handler_ref")

    if _has_column("registered_tools", "tool_type"):
        op.drop_column("registered_tools", "tool_type")

    if _has_column("registered_tools", "workspace_name"):
        op.drop_column("registered_tools", "workspace_name")
