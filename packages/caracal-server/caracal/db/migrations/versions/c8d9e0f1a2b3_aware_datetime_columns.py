"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Convert ledger and mandate timestamp columns to timezone-aware (DateTime with tz).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, Sequence[str], None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, column) pairs that participate in time-window or audit comparisons
# and must store UTC with timezone awareness for correct comparisons.
_AWARE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("ledger_events", "timestamp"),
    ("authority_ledger_events", "timestamp"),
    ("authority_ledger_events", "event_timestamp"),
    ("authority_ledger_events", "logged_at"),
    ("execution_mandates", "valid_from"),
    ("execution_mandates", "valid_until"),
    ("execution_mandates", "created_at"),
    ("execution_mandates", "revoked_at"),
    ("delegation_edges", "granted_at"),
    ("delegation_edges", "expires_at"),
    ("delegation_edges", "revoked_at"),
    ("authority_inbound_edges", "issued_at"),
    ("authority_inbound_edges", "source_token_revoked_at"),
    ("authority_inbound_edges", "consumed_at"),
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(c.get("name") == column_name for c in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _is_postgres():
        return

    for table, column in _AWARE_COLUMNS:
        if not _has_column(table, column):
            continue
        op.execute(
            sa.text(
                f"ALTER TABLE {table} "
                f"ALTER COLUMN {column} TYPE TIMESTAMPTZ "
                f"USING {column} AT TIME ZONE 'UTC'"
            )
        )


def downgrade() -> None:
    if not _is_postgres():
        return

    for table, column in _AWARE_COLUMNS:
        if not _has_column(table, column):
            continue
        op.execute(
            sa.text(
                f"ALTER TABLE {table} "
                f"ALTER COLUMN {column} TYPE TIMESTAMP "
                f"USING ({column} AT TIME ZONE 'UTC')"
            )
        )
