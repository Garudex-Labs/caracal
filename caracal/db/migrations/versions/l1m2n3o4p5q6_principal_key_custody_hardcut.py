"""Hard-cut principal key custody tables and private_key_pem removal

Revision ID: l1m2n3o4p5q6
Revises: k0l1m2n3o4p5
Create Date: 2026-04-03 16:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "l1m2n3o4p5q6"
down_revision: Union[str, Sequence[str], None] = "k0l1m2n3o4p5"
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


def upgrade() -> None:
    if not _has_table("principals"):
        return

    if not _has_table("principal_key_custody"):
        op.create_table(
            "principal_key_custody",
            sa.Column("custody_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("principal_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("backend", sa.String(length=50), nullable=False),
            sa.Column("key_reference", sa.String(length=2000), nullable=False),
            sa.Column("key_updated_at", sa.DateTime(), nullable=False, server_default=sa.text("NOW()")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("NOW()")),
            sa.Column("rotated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["principal_id"], ["principals.principal_id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("custody_id"),
            sa.UniqueConstraint("principal_id", name="uq_principal_key_custody_principal_id"),
        )

    if not _has_table("principal_key_custody_local"):
        op.create_table(
            "principal_key_custody_local",
            sa.Column("custody_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("private_key_ref", sa.String(length=2000), nullable=False),
            sa.ForeignKeyConstraint(["custody_id"], ["principal_key_custody.custody_id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("custody_id"),
        )

    if not _has_table("principal_key_custody_aws_kms"):
        op.create_table(
            "principal_key_custody_aws_kms",
            sa.Column("custody_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("kms_key_id", sa.String(length=512), nullable=False),
            sa.Column("kms_region", sa.String(length=128), nullable=True),
            sa.Column("ciphertext_b64", sa.String(length=8192), nullable=False),
            sa.ForeignKeyConstraint(["custody_id"], ["principal_key_custody.custody_id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("custody_id"),
        )

    existing_indexes = _index_names("principal_key_custody")
    if "ix_principal_key_custody_principal_id" not in existing_indexes:
        op.create_index(
            "ix_principal_key_custody_principal_id",
            "principal_key_custody",
            ["principal_id"],
            unique=True,
        )
    if "ix_principal_key_custody_backend" not in existing_indexes:
        op.create_index(
            "ix_principal_key_custody_backend",
            "principal_key_custody",
            ["backend"],
            unique=False,
        )

    # Backfill custody references from existing principal metadata.
    op.execute(
        """
        INSERT INTO principal_key_custody (
            custody_id,
            principal_id,
            backend,
            key_reference,
            key_updated_at,
            created_at,
            rotated_at
        )
        SELECT
            p.principal_id,
            p.principal_id,
            CASE
                WHEN COALESCE(NULLIF(p.metadata ->> 'key_backend', ''), '') = 'aws_kms'
                     OR (p.metadata ? 'aws_kms_ciphertext_b64') THEN 'aws_kms'
                ELSE 'local'
            END AS backend,
            COALESCE(
                NULLIF(p.metadata ->> 'private_key_ref', ''),
                CONCAT('principal://', p.principal_id::text)
            ) AS key_reference,
            NOW(),
            NOW(),
            NULL
        FROM principals p
        WHERE (p.metadata ? 'private_key_ref' OR p.metadata ? 'aws_kms_ciphertext_b64')
          AND NOT EXISTS (
              SELECT 1
              FROM principal_key_custody c
              WHERE c.principal_id = p.principal_id
          )
        """
    )

    op.execute(
        """
        INSERT INTO principal_key_custody_local (custody_id, private_key_ref)
        SELECT c.custody_id, c.key_reference
        FROM principal_key_custody c
        WHERE c.backend = 'local'
          AND NOT EXISTS (
              SELECT 1
              FROM principal_key_custody_local l
              WHERE l.custody_id = c.custody_id
          )
        """
    )

    op.execute(
        """
        INSERT INTO principal_key_custody_aws_kms (custody_id, kms_key_id, kms_region, ciphertext_b64)
        SELECT
            c.custody_id,
            COALESCE(NULLIF(p.metadata ->> 'aws_kms_key_id', ''), ''),
            NULLIF(p.metadata ->> 'aws_kms_region', ''),
            p.metadata ->> 'aws_kms_ciphertext_b64'
        FROM principal_key_custody c
        JOIN principals p ON p.principal_id = c.principal_id
        WHERE c.backend = 'aws_kms'
          AND COALESCE(NULLIF(p.metadata ->> 'aws_kms_ciphertext_b64', ''), '') <> ''
          AND NOT EXISTS (
              SELECT 1
              FROM principal_key_custody_aws_kms a
              WHERE a.custody_id = c.custody_id
          )
        """
    )

    # Hard-cut guard: refuse migration if inline PEM values still exist.
    if _has_column("principals", "private_key_pem"):
        remaining_inline = op.get_bind().execute(
            sa.text(
                """
                SELECT COUNT(*)
                FROM principals
                WHERE private_key_pem IS NOT NULL
                  AND BTRIM(private_key_pem) <> ''
                """
            )
        ).scalar_one()
        if int(remaining_inline) > 0:
            raise RuntimeError(
                "Hard-cut blocked: principals.private_key_pem still contains key material. "
                "Rotate/re-register principals so keys are stored through custody backends first."
            )

        op.drop_column("principals", "private_key_pem")


def downgrade() -> None:
    if not _has_table("principals"):
        return

    if not _has_column("principals", "private_key_pem"):
        op.add_column("principals", sa.Column("private_key_pem", sa.String(length=4000), nullable=True))

    if _has_table("principal_key_custody"):
        if "ix_principal_key_custody_backend" in _index_names("principal_key_custody"):
            op.drop_index("ix_principal_key_custody_backend", table_name="principal_key_custody")
        if "ix_principal_key_custody_principal_id" in _index_names("principal_key_custody"):
            op.drop_index("ix_principal_key_custody_principal_id", table_name="principal_key_custody")

    if _has_table("principal_key_custody_aws_kms"):
        op.drop_table("principal_key_custody_aws_kms")

    if _has_table("principal_key_custody_local"):
        op.drop_table("principal_key_custody_local")

    if _has_table("principal_key_custody"):
        op.drop_table("principal_key_custody")
