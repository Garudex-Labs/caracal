"""Add registered tools persistence table for explicit tool identity.

Revision ID: v1w2x3y4z5a6
Revises: u0v1w2x3y4z5
Create Date: 2026-04-08 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "v1w2x3y4z5a6"
down_revision: Union[str, Sequence[str], None] = "u0v1w2x3y4z5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(table_name: str, index_name: str) -> bool:
    if not _has_table(table_name):
        return False

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_table("registered_tools"):
        op.create_table(
            "registered_tools",
            sa.Column("tool_record_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("tool_id", sa.String(length=255), nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.PrimaryKeyConstraint("tool_record_id"),
            sa.UniqueConstraint("tool_id", name="uq_registered_tools_tool_id"),
        )

    if not _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.create_index("ix_registered_tools_tool_id", "registered_tools", ["tool_id"], unique=True)

    if not _has_index("registered_tools", "ix_registered_tools_active"):
        op.create_index("ix_registered_tools_active", "registered_tools", ["active"], unique=False)


def downgrade() -> None:
    if _has_index("registered_tools", "ix_registered_tools_active"):
        op.drop_index("ix_registered_tools_active", table_name="registered_tools")

    if _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.drop_index("ix_registered_tools_tool_id", table_name="registered_tools")

    if _has_table("registered_tools"):
        op.drop_table("registered_tools")
