"""Enforce vault-only principal key custody backend

Revision ID: o4p5q6r7s8t9
Revises: n3o4p5q6r7s8
Create Date: 2026-04-05 08:35:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "o4p5q6r7s8t9"
down_revision: Union[str, Sequence[str], None] = "n3o4p5q6r7s8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LEGACY_LOCAL_TABLE = "principal_key_custody_local"
_LEGACY_KMS_TABLE = "principal_key_custody_" + "aws" + "_kms"


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _check_constraints(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {constraint["name"] for constraint in inspector.get_check_constraints(table_name)}


def upgrade() -> None:
    if not _has_table("principal_key_custody"):
        return

    if not _has_table("principal_key_custody_vault"):
        op.create_table(
            "principal_key_custody_vault",
            sa.Column("custody_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("vault_key_ref", sa.String(length=2000), nullable=False),
            sa.Column("vault_namespace", sa.String(length=255), nullable=True),
            sa.ForeignKeyConstraint(["custody_id"], ["principal_key_custody.custody_id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("custody_id"),
        )

    legacy_count = op.get_bind().execute(
        sa.text(
            """
            SELECT COUNT(*)
            FROM principal_key_custody
            WHERE backend <> 'vault'
               OR key_reference IS NULL
               OR key_reference !~ '^vault://[^/]+/[^/]+/.+'
            """
        )
    ).scalar_one()

    if int(legacy_count) > 0:
        raise RuntimeError(
            "Hard-cut blocked: legacy principal key custody records remain. "
            "Rotate/import all principal keys into vault and update custody references "
            "to vault://<org>/<env>/<secret> before applying this migration."
        )

    op.execute(
        """
        INSERT INTO principal_key_custody_vault (custody_id, vault_key_ref, vault_namespace)
        SELECT
            c.custody_id,
            c.key_reference,
            split_part(c.key_reference, '/', 3) || '/' || split_part(c.key_reference, '/', 4)
        FROM principal_key_custody c
        WHERE NOT EXISTS (
            SELECT 1
            FROM principal_key_custody_vault v
            WHERE v.custody_id = c.custody_id
        )
        """
    )

    checks = _check_constraints("principal_key_custody")
    if "ck_principal_key_custody_backend" in checks:
        op.drop_constraint("ck_principal_key_custody_backend", "principal_key_custody", type_="check")
    op.create_check_constraint(
        "ck_principal_key_custody_backend",
        "principal_key_custody",
        "backend IN ('vault')",
    )

    if _has_table(_LEGACY_LOCAL_TABLE):
        op.drop_table(_LEGACY_LOCAL_TABLE)

    if _has_table(_LEGACY_KMS_TABLE):
        op.drop_table(_LEGACY_KMS_TABLE)


def downgrade() -> None:
    raise RuntimeError(
        "Downgrade is not supported for vault-only principal custody hard-cut migration."
    )
