"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enforce database-level append-only semantics on ledger tables via PostgreSQL rules.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a6b7c8d9e0f1"
down_revision: Union[str, Sequence[str], None] = "z5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_LEDGER_TABLES = ("ledger_events", "authority_ledger_events")


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _is_postgres():
        return

    for table in _LEDGER_TABLES:
        if not _has_table(table):
            continue
        op.execute(
            sa.text(
                f"CREATE OR REPLACE RULE {table}_no_update AS "
                f"ON UPDATE TO {table} DO INSTEAD NOTHING"
            )
        )
        op.execute(
            sa.text(
                f"CREATE OR REPLACE RULE {table}_no_delete AS "
                f"ON DELETE TO {table} DO INSTEAD NOTHING"
            )
        )


def downgrade() -> None:
    if not _is_postgres():
        return

    for table in _LEDGER_TABLES:
        if not _has_table(table):
            continue
        op.execute(sa.text(f"DROP RULE IF EXISTS {table}_no_update ON {table}"))
        op.execute(sa.text(f"DROP RULE IF EXISTS {table}_no_delete ON {table}"))
