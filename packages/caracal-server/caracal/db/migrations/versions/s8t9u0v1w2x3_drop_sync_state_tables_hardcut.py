"""Drop legacy sync-state tables after enterprise runtime decoupling.

Revision ID: s8t9u0v1w2x3
Revises: r7s8t9u0v1w2
Create Date: 2026-04-06 11:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


# revision identifiers, used by Alembic.
revision: str = "s8t9u0v1w2x3"
down_revision: Union[str, Sequence[str], None] = "r7s8t9u0v1w2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SYNC_INDEXES = {
    "sync_metadata": [
        "ix_sync_metadata_sync_enabled",
        "ix_sync_metadata_last_sync_at",
        "ix_sync_metadata_next_auto_sync_at",
    ],
    "sync_conflicts": [
        "ix_sync_conflicts_workspace",
        "ix_sync_conflicts_entity_type",
        "ix_sync_conflicts_entity_id",
        "ix_sync_conflicts_local_timestamp",
        "ix_sync_conflicts_remote_timestamp",
        "ix_sync_conflicts_detected_at",
        "ix_sync_conflicts_resolved_at",
        "ix_sync_conflicts_status",
        "ix_sync_conflicts_correlation_id",
        "ix_sync_conflicts_workspace_status",
        "ix_sync_conflicts_workspace_detected",
        "ix_sync_conflicts_entity",
    ],
    "sync_operations": [
        "ix_sync_operations_workspace",
        "ix_sync_operations_operation_type",
        "ix_sync_operations_entity_type",
        "ix_sync_operations_entity_id",
        "ix_sync_operations_created_at",
        "ix_sync_operations_scheduled_at",
        "ix_sync_operations_status",
        "ix_sync_operations_correlation_id",
        "ix_sync_operations_workspace_status",
        "ix_sync_operations_workspace_created",
        "ix_sync_operations_entity",
    ],
}


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
    for table_name in ("sync_metadata", "sync_conflicts", "sync_operations"):
        if not _has_table(table_name):
            continue

        for index_name in _SYNC_INDEXES.get(table_name, []):
            if _has_index(table_name, index_name):
                op.drop_index(index_name, table_name=table_name)

        op.drop_table(table_name)


def downgrade() -> None:
    if not _has_table("sync_operations"):
        op.create_table(
            "sync_operations",
            sa.Column("operation_id", UUID(as_uuid=True), primary_key=True),
            sa.Column("workspace", sa.String(64), nullable=False),
            sa.Column("operation_type", sa.String(20), nullable=False),
            sa.Column("entity_type", sa.String(100), nullable=False),
            sa.Column("entity_id", sa.String(255), nullable=False),
            sa.Column("operation_data", JSONB, nullable=False),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("scheduled_at", sa.DateTime, nullable=True),
            sa.Column("retry_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("last_retry_at", sa.DateTime, nullable=True),
            sa.Column("last_error", sa.String(2000), nullable=True),
            sa.Column("max_retries", sa.Integer, nullable=False, server_default="5"),
            sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
            sa.Column("completed_at", sa.DateTime, nullable=True),
            sa.Column("metadata", JSONB, nullable=True),
            sa.Column("correlation_id", sa.String(255), nullable=True),
        )
        op.create_index("ix_sync_operations_workspace", "sync_operations", ["workspace"])
        op.create_index("ix_sync_operations_operation_type", "sync_operations", ["operation_type"])
        op.create_index("ix_sync_operations_entity_type", "sync_operations", ["entity_type"])
        op.create_index("ix_sync_operations_entity_id", "sync_operations", ["entity_id"])
        op.create_index("ix_sync_operations_created_at", "sync_operations", ["created_at"])
        op.create_index("ix_sync_operations_scheduled_at", "sync_operations", ["scheduled_at"])
        op.create_index("ix_sync_operations_status", "sync_operations", ["status"])
        op.create_index("ix_sync_operations_correlation_id", "sync_operations", ["correlation_id"])
        op.create_index("ix_sync_operations_workspace_status", "sync_operations", ["workspace", "status"])
        op.create_index("ix_sync_operations_workspace_created", "sync_operations", ["workspace", "created_at"])
        op.create_index("ix_sync_operations_entity", "sync_operations", ["entity_type", "entity_id"])

    if not _has_table("sync_conflicts"):
        op.create_table(
            "sync_conflicts",
            sa.Column("conflict_id", UUID(as_uuid=True), primary_key=True),
            sa.Column("workspace", sa.String(64), nullable=False),
            sa.Column("entity_type", sa.String(100), nullable=False),
            sa.Column("entity_id", sa.String(255), nullable=False),
            sa.Column("local_version", JSONB, nullable=False),
            sa.Column("remote_version", JSONB, nullable=False),
            sa.Column("local_timestamp", sa.DateTime, nullable=False),
            sa.Column("remote_timestamp", sa.DateTime, nullable=False),
            sa.Column("detected_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("resolution_strategy", sa.String(50), nullable=True),
            sa.Column("resolved_version", JSONB, nullable=True),
            sa.Column("resolved_at", sa.DateTime, nullable=True),
            sa.Column("resolved_by", sa.String(255), nullable=True),
            sa.Column("status", sa.String(20), nullable=False, server_default="unresolved"),
            sa.Column("metadata", JSONB, nullable=True),
            sa.Column("correlation_id", sa.String(255), nullable=True),
        )
        op.create_index("ix_sync_conflicts_workspace", "sync_conflicts", ["workspace"])
        op.create_index("ix_sync_conflicts_entity_type", "sync_conflicts", ["entity_type"])
        op.create_index("ix_sync_conflicts_entity_id", "sync_conflicts", ["entity_id"])
        op.create_index("ix_sync_conflicts_local_timestamp", "sync_conflicts", ["local_timestamp"])
        op.create_index("ix_sync_conflicts_remote_timestamp", "sync_conflicts", ["remote_timestamp"])
        op.create_index("ix_sync_conflicts_detected_at", "sync_conflicts", ["detected_at"])
        op.create_index("ix_sync_conflicts_resolved_at", "sync_conflicts", ["resolved_at"])
        op.create_index("ix_sync_conflicts_status", "sync_conflicts", ["status"])
        op.create_index("ix_sync_conflicts_correlation_id", "sync_conflicts", ["correlation_id"])
        op.create_index("ix_sync_conflicts_workspace_status", "sync_conflicts", ["workspace", "status"])
        op.create_index("ix_sync_conflicts_workspace_detected", "sync_conflicts", ["workspace", "detected_at"])
        op.create_index("ix_sync_conflicts_entity", "sync_conflicts", ["entity_type", "entity_id"])

    if not _has_table("sync_metadata"):
        op.create_table(
            "sync_metadata",
            sa.Column("workspace", sa.String(64), primary_key=True),
            sa.Column("remote_url", sa.String(2048), nullable=True),
            sa.Column("remote_version", sa.String(50), nullable=True),
            sa.Column("sync_enabled", sa.Boolean, nullable=False, server_default="false"),
            sa.Column("last_sync_at", sa.DateTime, nullable=True),
            sa.Column("last_sync_direction", sa.String(20), nullable=True),
            sa.Column("last_sync_status", sa.String(20), nullable=True),
            sa.Column("total_operations_synced", sa.BigInteger, nullable=False, server_default="0"),
            sa.Column("total_conflicts_detected", sa.BigInteger, nullable=False, server_default="0"),
            sa.Column("total_conflicts_resolved", sa.BigInteger, nullable=False, server_default="0"),
            sa.Column("last_error", sa.String(2000), nullable=True),
            sa.Column("last_error_at", sa.DateTime, nullable=True),
            sa.Column("consecutive_failures", sa.Integer, nullable=False, server_default="0"),
            sa.Column("auto_sync_enabled", sa.Boolean, nullable=False, server_default="false"),
            sa.Column("auto_sync_interval_seconds", sa.Integer, nullable=True),
            sa.Column("next_auto_sync_at", sa.DateTime, nullable=True),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("metadata", JSONB, nullable=True),
        )
        op.create_index("ix_sync_metadata_sync_enabled", "sync_metadata", ["sync_enabled"])
        op.create_index("ix_sync_metadata_last_sync_at", "sync_metadata", ["last_sync_at"])
        op.create_index("ix_sync_metadata_next_auto_sync_at", "sync_metadata", ["next_auto_sync_at"])
