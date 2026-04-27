"""Decouple enterprise runtime persistence from sync metadata.

Revision ID: r7s8t9u0v1w2
Revises: q6r7s8t9u0v1
Create Date: 2026-04-06 09:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "r7s8t9u0v1w2"
down_revision: Union[str, Sequence[str], None] = "q6r7s8t9u0v1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ENTERPRISE_RUNTIME_KEY = "__enterprise_runtime__"


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    columns = inspector.get_columns(table_name)
    return any(column.get("name") == column_name for column in columns)


def upgrade() -> None:
    if not _has_table("enterprise_runtime_config"):
        op.create_table(
            "enterprise_runtime_config",
            sa.Column("runtime_key", sa.String(length=64), nullable=False),
            sa.Column(
                "config_data",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
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
            sa.PrimaryKeyConstraint("runtime_key"),
        )

    if _has_column("sync_metadata", "metadata"):
        op.execute(
            sa.text(
                """
                INSERT INTO enterprise_runtime_config (runtime_key, config_data, created_at, updated_at)
                SELECT
                    :runtime_key,
                    COALESCE((metadata -> 'enterprise_config')::jsonb, '{}'::jsonb),
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                FROM sync_metadata
                WHERE workspace = :runtime_key
                ON CONFLICT (runtime_key)
                DO UPDATE SET
                    config_data = EXCLUDED.config_data,
                    updated_at = CURRENT_TIMESTAMP
                """
            ),
            {"runtime_key": _ENTERPRISE_RUNTIME_KEY},
        )
        op.execute(
            sa.text(
                "DELETE FROM sync_metadata WHERE workspace = :runtime_key"
            ),
            {"runtime_key": _ENTERPRISE_RUNTIME_KEY},
        )


def downgrade() -> None:
    if _has_table("enterprise_runtime_config") and _has_column("sync_metadata", "metadata"):
        op.execute(
            sa.text(
                """
                INSERT INTO sync_metadata (workspace, sync_enabled, metadata, created_at, updated_at)
                SELECT
                    :runtime_key,
                    false,
                    jsonb_build_object('enterprise_config', COALESCE(config_data, '{}'::jsonb)),
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                FROM enterprise_runtime_config
                WHERE runtime_key = :runtime_key
                ON CONFLICT (workspace)
                DO UPDATE SET
                    metadata = EXCLUDED.metadata,
                    updated_at = CURRENT_TIMESTAMP
                """
            ),
            {"runtime_key": _ENTERPRISE_RUNTIME_KEY},
        )

    if _has_table("enterprise_runtime_config"):
        op.drop_table("enterprise_runtime_config")
