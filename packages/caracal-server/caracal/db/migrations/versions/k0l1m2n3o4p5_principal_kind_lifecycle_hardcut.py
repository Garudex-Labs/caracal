"""Hard-cut principal taxonomy and lifecycle columns

Revision ID: k0l1m2n3o4p5
Revises: j9k0l1m2n3o4
Create Date: 2026-04-03 14:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "k0l1m2n3o4p5"
down_revision: Union[str, Sequence[str], None] = "j9k0l1m2n3o4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(c["name"] == column_name for c in inspector.get_columns(table_name))


def _index_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {idx["name"] for idx in inspector.get_indexes(table_name)}


def _fk_name_for_column(table_name: str, constrained_column: str) -> str | None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for fk in inspector.get_foreign_keys(table_name):
        cols = fk.get("constrained_columns") or []
        if constrained_column in cols:
            return fk.get("name")
    return None


def upgrade() -> None:
    if not _has_table("principals"):
        return

    if not _has_column("principals", "principal_kind"):
        op.add_column(
            "principals",
            sa.Column("principal_kind", sa.String(length=50), nullable=True),
        )

    if not _has_column("principals", "lifecycle_status"):
        op.add_column(
            "principals",
            sa.Column(
                "lifecycle_status",
                sa.String(length=50),
                nullable=False,
                server_default="active",
            ),
        )

    if not _has_column("principals", "attestation_status"):
        op.add_column(
            "principals",
            sa.Column(
                "attestation_status",
                sa.String(length=50),
                nullable=False,
                server_default="unattested",
            ),
        )

    if not _has_column("principals", "source_principal_id"):
        op.add_column(
            "principals",
            sa.Column("source_principal_id", postgresql.UUID(as_uuid=True), nullable=True),
        )

    fk_name = _fk_name_for_column("principals", "source_principal_id")
    if fk_name is None:
        op.create_foreign_key(
            "fk_principals_source_principal_id_principals",
            "principals",
            "principals",
            ["source_principal_id"],
            ["principal_id"],
        )

    # Backfill behavioral kind from legacy principal_type.
    op.execute(
        """
        UPDATE principals
        SET principal_kind = CASE
            WHEN principal_type = 'user' THEN 'human'
            WHEN principal_type = 'agent' THEN 'worker'
            WHEN principal_type = 'service' THEN 'service'
            ELSE 'service'
        END
        WHERE principal_kind IS NULL
        """
    )

    op.alter_column("principals", "principal_kind", nullable=False)

    existing_indexes = _index_names("principals")
    if "ix_principals_principal_kind" not in existing_indexes:
        op.create_index("ix_principals_principal_kind", "principals", ["principal_kind"], unique=False)
    if "ix_principals_lifecycle_status" not in existing_indexes:
        op.create_index("ix_principals_lifecycle_status", "principals", ["lifecycle_status"], unique=False)
    if "ix_principals_attestation_status" not in existing_indexes:
        op.create_index("ix_principals_attestation_status", "principals", ["attestation_status"], unique=False)
    if "ix_principals_source_principal_id" not in existing_indexes:
        op.create_index("ix_principals_source_principal_id", "principals", ["source_principal_id"], unique=False)

    # Remove legacy principal_type after backfill.
    if _has_column("principals", "principal_type"):
        if "ix_principals_principal_type" in _index_names("principals"):
            op.drop_index("ix_principals_principal_type", table_name="principals")
        op.drop_column("principals", "principal_type")


def downgrade() -> None:
    if not _has_table("principals"):
        return

    if not _has_column("principals", "principal_type"):
        op.add_column(
            "principals",
            sa.Column("principal_type", sa.String(length=50), nullable=True),
        )

    op.execute(
        """
        UPDATE principals
        SET principal_type = CASE
            WHEN principal_kind = 'human' THEN 'user'
            WHEN principal_kind IN ('worker', 'orchestrator') THEN 'agent'
            WHEN principal_kind = 'service' THEN 'service'
            ELSE 'service'
        END
        WHERE principal_type IS NULL
        """
    )

    op.alter_column("principals", "principal_type", nullable=False)

    existing_indexes = _index_names("principals")
    if "ix_principals_principal_type" not in existing_indexes:
        op.create_index("ix_principals_principal_type", "principals", ["principal_type"], unique=False)

    if _has_column("principals", "principal_kind"):
        if "ix_principals_principal_kind" in _index_names("principals"):
            op.drop_index("ix_principals_principal_kind", table_name="principals")
        op.drop_column("principals", "principal_kind")

    if _has_column("principals", "lifecycle_status"):
        if "ix_principals_lifecycle_status" in _index_names("principals"):
            op.drop_index("ix_principals_lifecycle_status", table_name="principals")
        op.drop_column("principals", "lifecycle_status")

    if _has_column("principals", "attestation_status"):
        if "ix_principals_attestation_status" in _index_names("principals"):
            op.drop_index("ix_principals_attestation_status", table_name="principals")
        op.drop_column("principals", "attestation_status")

    if _has_column("principals", "source_principal_id"):
        if "ix_principals_source_principal_id" in _index_names("principals"):
            op.drop_index("ix_principals_source_principal_id", table_name="principals")
        fk_name = _fk_name_for_column("principals", "source_principal_id")
        if fk_name:
            op.drop_constraint(
                fk_name,
                "principals",
                type_="foreignkey",
            )
        op.drop_column("principals", "source_principal_id")
