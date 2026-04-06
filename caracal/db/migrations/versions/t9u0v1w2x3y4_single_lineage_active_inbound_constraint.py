"""Enforce single active inbound delegation edge per target mandate.

Revision ID: t9u0v1w2x3y4
Revises: s8t9u0v1w2x3
Create Date: 2026-04-06 13:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "t9u0v1w2x3y4"
down_revision: Union[str, Sequence[str], None] = "s8t9u0v1w2x3"
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


def _dedupe_active_inbound_edges() -> None:
    """Revoke duplicate active inbound edges to satisfy single-lineage uniqueness."""
    bind = op.get_bind()

    duplicate_targets = bind.execute(
        sa.text(
            """
            SELECT target_mandate_id
            FROM delegation_edges
            WHERE revoked = false
            GROUP BY target_mandate_id
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()

    for row in duplicate_targets:
        target_mandate_id = row[0]
        edge_rows = bind.execute(
            sa.text(
                """
                SELECT edge_id
                FROM delegation_edges
                WHERE target_mandate_id = :target_mandate_id
                  AND revoked = false
                ORDER BY granted_at ASC NULLS LAST, edge_id ASC
                """
            ),
            {"target_mandate_id": target_mandate_id},
        ).fetchall()

        # Keep oldest active edge; revoke the rest.
        for edge_row in edge_rows[1:]:
            bind.execute(
                sa.text(
                    """
                    UPDATE delegation_edges
                    SET revoked = true,
                        revoked_at = COALESCE(revoked_at, NOW())
                    WHERE edge_id = :edge_id
                    """
                ),
                {"edge_id": edge_row[0]},
            )


def upgrade() -> None:
    if not _has_table("delegation_edges"):
        return

    _dedupe_active_inbound_edges()

    index_name = "uq_delegation_edges_active_target_inbound"
    if not _has_index("delegation_edges", index_name):
        op.create_index(
            index_name,
            "delegation_edges",
            ["target_mandate_id"],
            unique=True,
            postgresql_where=sa.text("revoked = false"),
        )


def downgrade() -> None:
    index_name = "uq_delegation_edges_active_target_inbound"
    if _has_index("delegation_edges", index_name):
        op.drop_index(index_name, table_name="delegation_edges")
