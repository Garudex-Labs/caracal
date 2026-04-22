"""Add session handoff transactional state for hard-cut narrowing.

Revision ID: q6r7s8t9u0v1
Revises: p5q6r7s8t9u0
Create Date: 2026-04-05 12:45:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "q6r7s8t9u0v1"
down_revision: Union[str, Sequence[str], None] = "p5q6r7s8t9u0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if _has_table("session_handoff_transfers"):
        return

    op.create_table(
        "session_handoff_transfers",
        sa.Column("transfer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("handoff_jti", sa.String(length=255), nullable=False),
        sa.Column("source_token_jti", sa.String(length=255), nullable=False),
        sa.Column("source_subject_id", sa.String(length=255), nullable=False),
        sa.Column("target_subject_id", sa.String(length=255), nullable=False),
        sa.Column("organization_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("transferred_caveats", sa.JSON(), nullable=False),
        sa.Column("source_remaining_caveats", sa.JSON(), nullable=False),
        sa.Column("issued_at", sa.DateTime(), nullable=False),
        sa.Column("source_token_revoked_at", sa.DateTime(), nullable=True),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("transfer_id"),
    )

    op.create_index(
        "ix_session_handoff_transfers_handoff_jti",
        "session_handoff_transfers",
        ["handoff_jti"],
        unique=True,
    )
    op.create_index(
        "ix_session_handoff_transfers_source_token_jti",
        "session_handoff_transfers",
        ["source_token_jti"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_source_subject_id",
        "session_handoff_transfers",
        ["source_subject_id"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_target_subject_id",
        "session_handoff_transfers",
        ["target_subject_id"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_organization_id",
        "session_handoff_transfers",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_tenant_id",
        "session_handoff_transfers",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_issued_at",
        "session_handoff_transfers",
        ["issued_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_source_token_revoked_at",
        "session_handoff_transfers",
        ["source_token_revoked_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_consumed_at",
        "session_handoff_transfers",
        ["consumed_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_source_revoked",
        "session_handoff_transfers",
        ["source_token_jti", "source_token_revoked_at"],
        unique=False,
    )
    op.create_index(
        "ix_session_handoff_transfers_handoff_consumed",
        "session_handoff_transfers",
        ["handoff_jti", "consumed_at"],
        unique=False,
    )


def downgrade() -> None:
    if not _has_table("session_handoff_transfers"):
        return

    op.drop_index("ix_session_handoff_transfers_handoff_consumed", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_source_revoked", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_consumed_at", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_source_token_revoked_at", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_issued_at", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_tenant_id", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_organization_id", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_target_subject_id", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_source_subject_id", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_source_token_jti", table_name="session_handoff_transfers")
    op.drop_index("ix_session_handoff_transfers_handoff_jti", table_name="session_handoff_transfers")

    op.drop_table("session_handoff_transfers")
