"""Add workspace-scoped active uniqueness constraints for registered_tools.

Revision ID: z5a6b7c8d9e0
Revises: y4z5a6b7c8d9
Create Date: 2026-04-09 18:40:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "z5a6b7c8d9e0"
down_revision: Union[str, Sequence[str], None] = "y4z5a6b7c8d9"
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
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(table_name: str, constraint_name: str) -> bool:
    if not _has_table(table_name):
        return False

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(
        constraint.get("name") == constraint_name
        for constraint in inspector.get_unique_constraints(table_name)
    )


def upgrade() -> None:
    if not _has_table("registered_tools"):
        return

    op.execute(
        sa.text(
            "UPDATE registered_tools SET workspace_name = 'default' "
            "WHERE workspace_name IS NULL OR trim(workspace_name) = ''"
        )
    )

    if _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.drop_index("ix_registered_tools_tool_id", table_name="registered_tools")

    if _has_unique_constraint("registered_tools", "uq_registered_tools_tool_id"):
        op.drop_constraint(
            "uq_registered_tools_tool_id",
            "registered_tools",
            type_="unique",
        )

    if not _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.create_index(
            "ix_registered_tools_tool_id",
            "registered_tools",
            ["tool_id"],
            unique=False,
        )

    if not _has_index("registered_tools", "uq_registered_tools_active_workspace_tool_id"):
        op.create_index(
            "uq_registered_tools_active_workspace_tool_id",
            "registered_tools",
            ["workspace_name", "tool_id"],
            unique=True,
            postgresql_where=sa.text("active = true"),
        )

    if not _has_index("registered_tools", "uq_registered_tools_active_workspace_binding"):
        op.create_index(
            "uq_registered_tools_active_workspace_binding",
            "registered_tools",
            [
                "workspace_name",
                "provider_name",
                "resource_scope",
                "action_scope",
                "tool_type",
            ],
            unique=True,
            postgresql_where=sa.text("active = true"),
        )


def downgrade() -> None:
    if not _has_table("registered_tools"):
        return

    if _has_index("registered_tools", "uq_registered_tools_active_workspace_binding"):
        op.drop_index(
            "uq_registered_tools_active_workspace_binding",
            table_name="registered_tools",
        )

    if _has_index("registered_tools", "uq_registered_tools_active_workspace_tool_id"):
        op.drop_index(
            "uq_registered_tools_active_workspace_tool_id",
            table_name="registered_tools",
        )

    if _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.drop_index("ix_registered_tools_tool_id", table_name="registered_tools")

    if not _has_unique_constraint("registered_tools", "uq_registered_tools_tool_id"):
        op.create_unique_constraint(
            "uq_registered_tools_tool_id",
            "registered_tools",
            ["tool_id"],
        )

    if not _has_index("registered_tools", "ix_registered_tools_tool_id"):
        op.create_index(
            "ix_registered_tools_tool_id",
            "registered_tools",
            ["tool_id"],
            unique=True,
        )
