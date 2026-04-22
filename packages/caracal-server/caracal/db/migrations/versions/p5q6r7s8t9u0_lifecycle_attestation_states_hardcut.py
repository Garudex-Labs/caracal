"""Expand principal lifecycle statuses for attestation hard-cut

Revision ID: p5q6r7s8t9u0
Revises: o4p5q6r7s8t9
Create Date: 2026-04-05 10:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "p5q6r7s8t9u0"
down_revision: Union[str, Sequence[str], None] = "o4p5q6r7s8t9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _check_constraints(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {c["name"] for c in inspector.get_check_constraints(table_name) if c.get("name")}


def upgrade() -> None:
    if not _has_table("principals"):
        return

    # Spawned principals that are still pending attestation must begin in
    # pending_attestation lifecycle state under the hard-cut model.
    op.execute(
        """
        UPDATE principals
        SET lifecycle_status = 'pending_attestation'
        WHERE principal_kind IN ('worker', 'orchestrator')
          AND attestation_status = 'pending'
          AND lifecycle_status = 'active'
        """
    )

    checks = _check_constraints("principals")
    if "ck_principals_lifecycle_status_values" in checks:
        op.drop_constraint(
            "ck_principals_lifecycle_status_values",
            "principals",
            type_="check",
        )

    op.create_check_constraint(
        "ck_principals_lifecycle_status_values",
        "principals",
        "lifecycle_status IN ('pending_attestation','active','suspended','deactivated','expired','revoked')",
    )


def downgrade() -> None:
    if not _has_table("principals"):
        return

    # Fold new hard-cut lifecycle states back into legacy values before
    # restoring the previous check constraint.
    op.execute(
        """
        UPDATE principals
        SET lifecycle_status = CASE
            WHEN lifecycle_status = 'pending_attestation' THEN 'active'
            WHEN lifecycle_status = 'expired' THEN 'deactivated'
            ELSE lifecycle_status
        END
        """
    )

    checks = _check_constraints("principals")
    if "ck_principals_lifecycle_status_values" in checks:
        op.drop_constraint(
            "ck_principals_lifecycle_status_values",
            "principals",
            type_="check",
        )

    op.create_check_constraint(
        "ck_principals_lifecycle_status_values",
        "principals",
        "lifecycle_status IN ('active','suspended','deactivated','revoked')",
    )
