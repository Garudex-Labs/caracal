"""Drop single-lineage inbound delegation constraint for graph authority.

Revision ID: u0v1w2x3y4z5
Revises: t9u0v1w2x3y4
Create Date: 2026-04-06 17:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "u0v1w2x3y4z5"
down_revision: Union[str, Sequence[str], None] = "t9u0v1w2x3y4"
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
    index_name = "uq_delegation_edges_active_target_inbound"
    if _has_index("delegation_edges", index_name):
        op.drop_index(index_name, table_name="delegation_edges")


def downgrade() -> None:
    if not _has_table("delegation_edges"):
        return

    index_name = "uq_delegation_edges_active_target_inbound"
    if not _has_index("delegation_edges", index_name):
        op.create_index(
            index_name,
            "delegation_edges",
            ["target_mandate_id"],
            unique=True,
            postgresql_where=sa.text("revoked = false"),
        )
