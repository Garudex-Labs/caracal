"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Replace global unique on principals.name with a tenant-scoped composite (owner, name).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, Sequence[str], None] = "a6b7c8d9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "principals"
_COMPOSITE_INDEX = "uq_principals_owner_name"
_LEGACY_NAME_UNIQUE = "principals_name_key"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _existing_unique_constraints(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {c.get("name") for c in inspector.get_unique_constraints(table_name) if c.get("name")}


def _existing_indexes(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {i.get("name") for i in inspector.get_indexes(table_name) if i.get("name")}


def upgrade() -> None:
    if not _has_table(_TABLE):
        return

    # Add composite unique first so we never lose name uniqueness during migration.
    indexes = _existing_indexes(_TABLE)
    if _COMPOSITE_INDEX not in indexes:
        if _is_postgres():
            with op.get_context().autocommit_block():
                op.execute(
                    sa.text(
                        f"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "
                        f"{_COMPOSITE_INDEX} ON {_TABLE} (owner, name)"
                    )
                )
        else:
            op.create_index(_COMPOSITE_INDEX, _TABLE, ["owner", "name"], unique=True)

    constraints = _existing_unique_constraints(_TABLE)
    if _LEGACY_NAME_UNIQUE in constraints:
        op.drop_constraint(_LEGACY_NAME_UNIQUE, _TABLE, type_="unique")


def downgrade() -> None:
    if not _has_table(_TABLE):
        return

    constraints = _existing_unique_constraints(_TABLE)
    if _LEGACY_NAME_UNIQUE not in constraints:
        op.create_unique_constraint(_LEGACY_NAME_UNIQUE, _TABLE, ["name"])

    indexes = _existing_indexes(_TABLE)
    if _COMPOSITE_INDEX in indexes:
        op.drop_index(_COMPOSITE_INDEX, table_name=_TABLE)
