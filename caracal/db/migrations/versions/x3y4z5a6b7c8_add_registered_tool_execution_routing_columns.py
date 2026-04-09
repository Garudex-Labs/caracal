"""Add execution routing columns to registered_tools.

Revision ID: x3y4z5a6b7c8
Revises: w2x3y4z5a6b7
Create Date: 2026-04-08 20:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "x3y4z5a6b7c8"
down_revision: Union[str, Sequence[str], None] = "w2x3y4z5a6b7"
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
    if not _has_column("registered_tools", "execution_mode"):
        op.add_column(
            "registered_tools",
            sa.Column(
                "execution_mode",
                sa.String(length=32),
                nullable=False,
                server_default="mcp_forward",
            ),
        )

    if not _has_column("registered_tools", "mcp_server_name"):
        op.add_column(
            "registered_tools",
            sa.Column("mcp_server_name", sa.String(length=255), nullable=True),
        )

    if not _has_index("registered_tools", "ix_registered_tools_mcp_server_name"):
        op.create_index(
            "ix_registered_tools_mcp_server_name",
            "registered_tools",
            ["mcp_server_name"],
            unique=False,
        )


def downgrade() -> None:
    if _has_index("registered_tools", "ix_registered_tools_mcp_server_name"):
        op.drop_index("ix_registered_tools_mcp_server_name", table_name="registered_tools")

    if _has_column("registered_tools", "mcp_server_name"):
        op.drop_column("registered_tools", "mcp_server_name")

    if _has_column("registered_tools", "execution_mode"):
        op.drop_column("registered_tools", "execution_mode")
