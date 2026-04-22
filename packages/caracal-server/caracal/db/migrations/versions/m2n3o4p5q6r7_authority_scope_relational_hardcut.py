"""Hard-cut authority JSON scope/tag structures to relational tables

Revision ID: m2n3o4p5q6r7
Revises: l1m2n3o4p5q6
Create Date: 2026-04-03 18:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "m2n3o4p5q6r7"
down_revision: Union[str, Sequence[str], None] = "l1m2n3o4p5q6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {idx["name"] for idx in inspector.get_indexes(table_name)}


def upgrade() -> None:
    if not _has_table("execution_mandates"):
        return

    if not _has_table("mandate_resource_scopes"):
        op.create_table(
            "mandate_resource_scopes",
            sa.Column("resource_scope_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("mandate_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("resource_scope", sa.String(length=1000), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["mandate_id"], ["execution_mandates.mandate_id"], ondelete="CASCADE"),
        )

    if not _has_table("mandate_action_scopes"):
        op.create_table(
            "mandate_action_scopes",
            sa.Column("action_scope_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("mandate_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("action_scope", sa.String(length=255), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["mandate_id"], ["execution_mandates.mandate_id"], ondelete="CASCADE"),
        )

    if not _has_table("mandate_context_tags"):
        op.create_table(
            "mandate_context_tags",
            sa.Column("context_tag_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("mandate_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("context_tag", sa.String(length=255), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["mandate_id"], ["execution_mandates.mandate_id"], ondelete="CASCADE"),
        )

    if not _has_table("delegation_edge_tags"):
        op.create_table(
            "delegation_edge_tags",
            sa.Column("edge_tag_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("edge_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("context_tag", sa.String(length=255), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["edge_id"], ["delegation_edges.edge_id"], ondelete="CASCADE"),
        )

    if not _has_table("principal_workload_bindings"):
        op.create_table(
            "principal_workload_bindings",
            sa.Column("binding_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("principal_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("workload", sa.String(length=255), nullable=False),
            sa.Column("binding_type", sa.String(length=50), nullable=False, server_default="workload"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("NOW()")),
            sa.ForeignKeyConstraint(["principal_id"], ["principals.principal_id"], ondelete="CASCADE"),
        )

    if not _has_table("principal_capability_grants"):
        op.create_table(
            "principal_capability_grants",
            sa.Column("grant_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("principal_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("capability", sa.String(length=255), nullable=False),
            sa.Column("granted_by", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("NOW()")),
            sa.ForeignKeyConstraint(["principal_id"], ["principals.principal_id"], ondelete="CASCADE"),
        )

    if not _has_table("authority_event_attributes"):
        op.create_table(
            "authority_event_attributes",
            sa.Column("attribute_id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("event_id", sa.BigInteger(), nullable=False),
            sa.Column("attribute_key", sa.String(length=255), nullable=False),
            sa.Column("attribute_value", sa.String(length=4000), nullable=False),
            sa.Column("value_type", sa.String(length=20), nullable=False, server_default="str"),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["event_id"], ["authority_ledger_events.event_id"], ondelete="CASCADE"),
        )

    if "ix_mandate_resource_scopes_mandate_id" not in _index_names("mandate_resource_scopes"):
        op.create_index("ix_mandate_resource_scopes_mandate_id", "mandate_resource_scopes", ["mandate_id"], unique=False)
    if "ix_mandate_action_scopes_mandate_id" not in _index_names("mandate_action_scopes"):
        op.create_index("ix_mandate_action_scopes_mandate_id", "mandate_action_scopes", ["mandate_id"], unique=False)
    if "ix_mandate_context_tags_mandate_id" not in _index_names("mandate_context_tags"):
        op.create_index("ix_mandate_context_tags_mandate_id", "mandate_context_tags", ["mandate_id"], unique=False)
    if "ix_delegation_edge_tags_edge_id" not in _index_names("delegation_edge_tags"):
        op.create_index("ix_delegation_edge_tags_edge_id", "delegation_edge_tags", ["edge_id"], unique=False)
    if "ix_principal_workload_bindings_principal_id" not in _index_names("principal_workload_bindings"):
        op.create_index("ix_principal_workload_bindings_principal_id", "principal_workload_bindings", ["principal_id"], unique=False)
    if "ix_principal_capability_grants_principal_id" not in _index_names("principal_capability_grants"):
        op.create_index("ix_principal_capability_grants_principal_id", "principal_capability_grants", ["principal_id"], unique=False)
    if "ix_authority_event_attributes_event_id" not in _index_names("authority_event_attributes"):
        op.create_index("ix_authority_event_attributes_event_id", "authority_event_attributes", ["event_id"], unique=False)

    if _has_column("execution_mandates", "resource_scope"):
        op.execute(
            """
            INSERT INTO mandate_resource_scopes (mandate_id, resource_scope, position)
            SELECT em.mandate_id, scope.value, scope.ordinality - 1
            FROM execution_mandates em
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(em.resource_scope, '[]'::jsonb))
                WITH ORDINALITY AS scope(value, ordinality)
            """
        )

    if _has_column("execution_mandates", "action_scope"):
        op.execute(
            """
            INSERT INTO mandate_action_scopes (mandate_id, action_scope, position)
            SELECT em.mandate_id, scope.value, scope.ordinality - 1
            FROM execution_mandates em
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(em.action_scope, '[]'::jsonb))
                WITH ORDINALITY AS scope(value, ordinality)
            """
        )

    if _has_column("execution_mandates", "context_tags"):
        op.execute(
            """
            INSERT INTO mandate_context_tags (mandate_id, context_tag, position)
            SELECT em.mandate_id, scope.value, scope.ordinality - 1
            FROM execution_mandates em
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(em.context_tags, '[]'::jsonb))
                WITH ORDINALITY AS scope(value, ordinality)
            """
        )

    if _has_column("delegation_edges", "context_tags"):
        op.execute(
            """
            INSERT INTO delegation_edge_tags (edge_id, context_tag, position)
            SELECT de.edge_id, scope.value, scope.ordinality - 1
            FROM delegation_edges de
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(de.context_tags, '[]'::jsonb))
                WITH ORDINALITY AS scope(value, ordinality)
            """
        )

    if _has_column("principals", "metadata"):
        op.execute(
            """
            INSERT INTO principal_workload_bindings (principal_id, workload, binding_type, created_at)
            SELECT p.principal_id, wb.value, 'workload', NOW()
            FROM principals p
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.metadata -> 'workload_bindings', '[]'::jsonb)) AS wb(value)
            """
        )
        op.execute(
            """
            INSERT INTO principal_capability_grants (principal_id, capability, granted_by, created_at)
            SELECT p.principal_id, cap.value, NULL, NOW()
            FROM principals p
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.metadata -> 'capabilities', '[]'::jsonb)) AS cap(value)
            """
        )

    if _has_column("authority_ledger_events", "event_metadata"):
        op.execute(
            """
            INSERT INTO authority_event_attributes (event_id, attribute_key, attribute_value, value_type, position)
            SELECT ale.event_id, attrs.key, attrs.value, 'str', 0
            FROM authority_ledger_events ale
            CROSS JOIN LATERAL jsonb_each_text(COALESCE(ale.event_metadata, '{}'::jsonb)) AS attrs(key, value)
            """
        )

    if _has_column("execution_mandates", "resource_scope"):
        op.drop_column("execution_mandates", "resource_scope")
    if _has_column("execution_mandates", "action_scope"):
        op.drop_column("execution_mandates", "action_scope")
    if _has_column("execution_mandates", "context_tags"):
        op.drop_column("execution_mandates", "context_tags")
    if _has_column("delegation_edges", "context_tags"):
        op.drop_column("delegation_edges", "context_tags")
    if _has_column("authority_ledger_events", "event_metadata"):
        op.drop_column("authority_ledger_events", "event_metadata")


def downgrade() -> None:
    if _has_table("execution_mandates"):
        if not _has_column("execution_mandates", "resource_scope"):
            op.add_column(
                "execution_mandates",
                sa.Column("resource_scope", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            )
        if not _has_column("execution_mandates", "action_scope"):
            op.add_column(
                "execution_mandates",
                sa.Column("action_scope", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            )
        if not _has_column("execution_mandates", "context_tags"):
            op.add_column(
                "execution_mandates",
                sa.Column("context_tags", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            )

    if _has_table("delegation_edges") and not _has_column("delegation_edges", "context_tags"):
        op.add_column(
            "delegation_edges",
            sa.Column("context_tags", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        )

    if _has_table("authority_ledger_events") and not _has_column("authority_ledger_events", "event_metadata"):
        op.add_column(
            "authority_ledger_events",
            sa.Column("event_metadata", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        )

    if _has_table("authority_event_attributes"):
        if "ix_authority_event_attributes_event_id" in _index_names("authority_event_attributes"):
            op.drop_index("ix_authority_event_attributes_event_id", table_name="authority_event_attributes")
        op.drop_table("authority_event_attributes")

    if _has_table("principal_capability_grants"):
        if "ix_principal_capability_grants_principal_id" in _index_names("principal_capability_grants"):
            op.drop_index("ix_principal_capability_grants_principal_id", table_name="principal_capability_grants")
        op.drop_table("principal_capability_grants")

    if _has_table("principal_workload_bindings"):
        if "ix_principal_workload_bindings_principal_id" in _index_names("principal_workload_bindings"):
            op.drop_index("ix_principal_workload_bindings_principal_id", table_name="principal_workload_bindings")
        op.drop_table("principal_workload_bindings")

    if _has_table("delegation_edge_tags"):
        if "ix_delegation_edge_tags_edge_id" in _index_names("delegation_edge_tags"):
            op.drop_index("ix_delegation_edge_tags_edge_id", table_name="delegation_edge_tags")
        op.drop_table("delegation_edge_tags")

    if _has_table("mandate_context_tags"):
        if "ix_mandate_context_tags_mandate_id" in _index_names("mandate_context_tags"):
            op.drop_index("ix_mandate_context_tags_mandate_id", table_name="mandate_context_tags")
        op.drop_table("mandate_context_tags")

    if _has_table("mandate_action_scopes"):
        if "ix_mandate_action_scopes_mandate_id" in _index_names("mandate_action_scopes"):
            op.drop_index("ix_mandate_action_scopes_mandate_id", table_name="mandate_action_scopes")
        op.drop_table("mandate_action_scopes")

    if _has_table("mandate_resource_scopes"):
        if "ix_mandate_resource_scopes_mandate_id" in _index_names("mandate_resource_scopes"):
            op.drop_index("ix_mandate_resource_scopes_mandate_id", table_name="mandate_resource_scopes")
        op.drop_table("mandate_resource_scopes")
