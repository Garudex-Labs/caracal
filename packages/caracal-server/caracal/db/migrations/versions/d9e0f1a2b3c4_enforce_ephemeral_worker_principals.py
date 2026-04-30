"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enforce ephemeral worker principals at the database boundary.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, Sequence[str], None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE authority_policies
        SET active = false
        FROM principals
        WHERE authority_policies.principal_id = principals.principal_id
          AND principals.principal_kind = 'worker'
          AND authority_policies.active = true
        """
    )
    op.execute(
        """
        ALTER TABLE execution_mandates
        DROP CONSTRAINT IF EXISTS ck_execution_mandates_source_distance
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION caracal_enforce_ephemeral_worker_principals()
        RETURNS trigger AS $$
        DECLARE
            resolved_principal_kind text;
        BEGIN
            IF TG_TABLE_NAME = 'principals' THEN
                IF NEW.principal_kind = 'worker'
                   AND (
                       NEW.source_principal_id IS NULL
                       OR COALESCE(NEW.metadata->>'created_via', '') <> 'spawn'
                       OR COALESCE(NEW.metadata->>'worker_ephemeral', '') <> 'true'
                   ) THEN
                    RAISE EXCEPTION 'worker principals must be spawned with ephemeral metadata';
                END IF;
                RETURN NEW;
            END IF;

            IF TG_TABLE_NAME = 'authority_policies' THEN
                SELECT principal_kind INTO resolved_principal_kind
                FROM principals
                WHERE principal_id = NEW.principal_id;

                IF resolved_principal_kind = 'worker' THEN
                    RAISE EXCEPTION 'worker principals cannot hold authority policies';
                END IF;
                RETURN NEW;
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_principals_ephemeral_worker ON principals;
        CREATE TRIGGER trg_principals_ephemeral_worker
        BEFORE INSERT OR UPDATE OF principal_kind, source_principal_id, metadata
        ON principals
        FOR EACH ROW
        EXECUTE FUNCTION caracal_enforce_ephemeral_worker_principals()
        """
    )
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_authority_policies_no_worker ON authority_policies;
        CREATE TRIGGER trg_authority_policies_no_worker
        BEFORE INSERT OR UPDATE OF principal_id
        ON authority_policies
        FOR EACH ROW
        EXECUTE FUNCTION caracal_enforce_ephemeral_worker_principals()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_authority_policies_no_worker ON authority_policies")
    op.execute("DROP TRIGGER IF EXISTS trg_principals_ephemeral_worker ON principals")
    op.execute("DROP FUNCTION IF EXISTS caracal_enforce_ephemeral_worker_principals()")
    op.execute(
        """
        ALTER TABLE execution_mandates
        ADD CONSTRAINT ck_execution_mandates_source_distance
        CHECK (
            (source_mandate_id IS NULL AND COALESCE(network_distance, 0) = 0)
            OR (source_mandate_id IS NOT NULL AND COALESCE(network_distance, 0) > 0)
        )
        """
    )
