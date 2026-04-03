"""Add strict relational constraints for authority attenuation and lifecycle

Revision ID: n3o4p5q6r7s8
Revises: m2n3o4p5q6r7
Create Date: 2026-04-03 19:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "n3o4p5q6r7s8"
down_revision: Union[str, Sequence[str], None] = "m2n3o4p5q6r7"
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


def _unique_constraints(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {c["name"] for c in inspector.get_unique_constraints(table_name) if c.get("name")}


def upgrade() -> None:
    if not _has_table("principals"):
        return

    # Data cleanup before uniqueness enforcement.
    if _has_table("mandate_resource_scopes"):
        op.execute(
            """
            DELETE FROM mandate_resource_scopes a
            USING mandate_resource_scopes b
            WHERE a.resource_scope_id > b.resource_scope_id
              AND a.mandate_id = b.mandate_id
              AND a.resource_scope = b.resource_scope
            """
        )
    if _has_table("mandate_action_scopes"):
        op.execute(
            """
            DELETE FROM mandate_action_scopes a
            USING mandate_action_scopes b
            WHERE a.action_scope_id > b.action_scope_id
              AND a.mandate_id = b.mandate_id
              AND a.action_scope = b.action_scope
            """
        )
    if _has_table("mandate_context_tags"):
        op.execute(
            """
            DELETE FROM mandate_context_tags a
            USING mandate_context_tags b
            WHERE a.context_tag_id > b.context_tag_id
              AND a.mandate_id = b.mandate_id
              AND a.context_tag = b.context_tag
            """
        )
    if _has_table("delegation_edge_tags"):
        op.execute(
            """
            DELETE FROM delegation_edge_tags a
            USING delegation_edge_tags b
            WHERE a.edge_tag_id > b.edge_tag_id
              AND a.edge_id = b.edge_id
              AND a.context_tag = b.context_tag
            """
        )
    if _has_table("authority_event_attributes"):
        op.execute(
            """
            DELETE FROM authority_event_attributes a
            USING authority_event_attributes b
            WHERE a.attribute_id > b.attribute_id
              AND a.event_id = b.event_id
              AND a.attribute_key = b.attribute_key
            """
        )
    if _has_table("principal_capability_grants"):
        op.execute(
            """
            DELETE FROM principal_capability_grants a
            USING principal_capability_grants b
            WHERE a.grant_id > b.grant_id
              AND a.principal_id = b.principal_id
              AND a.capability = b.capability
            """
        )
    if _has_table("principal_workload_bindings"):
        op.execute(
            """
            DELETE FROM principal_workload_bindings a
            USING principal_workload_bindings b
            WHERE a.binding_id > b.binding_id
              AND a.principal_id = b.principal_id
              AND a.workload = b.workload
              AND a.binding_type = b.binding_type
            """
        )

    # Normalize attenuation depth before adding strict check.
    if _has_table("execution_mandates"):
        op.execute(
            """
            UPDATE execution_mandates
            SET network_distance = 1
            WHERE source_mandate_id IS NOT NULL
              AND COALESCE(network_distance, 0) <= 0
            """
        )

    principal_checks = _check_constraints("principals")
    if "ck_principals_source_not_self" not in principal_checks:
        op.create_check_constraint(
            "ck_principals_source_not_self",
            "principals",
            "source_principal_id IS NULL OR source_principal_id <> principal_id",
        )
    if "ck_principals_lifecycle_status_values" not in principal_checks:
        op.create_check_constraint(
            "ck_principals_lifecycle_status_values",
            "principals",
            "lifecycle_status IN ('active','suspended','deactivated','revoked')",
        )
    if "ck_principals_attestation_status_values" not in principal_checks:
        op.create_check_constraint(
            "ck_principals_attestation_status_values",
            "principals",
            "attestation_status IN ('unattested','pending','attested','failed')",
        )

    if _has_table("principal_key_custody"):
        custody_checks = _check_constraints("principal_key_custody")
        if "ck_principal_key_custody_backend" not in custody_checks:
            op.create_check_constraint(
                "ck_principal_key_custody_backend",
                "principal_key_custody",
                "backend IN ('local','aws_kms')",
            )

    if _has_table("execution_mandates"):
        mandate_checks = _check_constraints("execution_mandates")
        if "ck_execution_mandates_valid_window" not in mandate_checks:
            op.create_check_constraint(
                "ck_execution_mandates_valid_window",
                "execution_mandates",
                "valid_until > valid_from",
            )
        if "ck_execution_mandates_network_distance_nonnegative" not in mandate_checks:
            op.create_check_constraint(
                "ck_execution_mandates_network_distance_nonnegative",
                "execution_mandates",
                "COALESCE(network_distance, 0) >= 0",
            )
        if "ck_execution_mandates_source_distance" not in mandate_checks:
            op.create_check_constraint(
                "ck_execution_mandates_source_distance",
                "execution_mandates",
                "(source_mandate_id IS NULL AND COALESCE(network_distance, 0) = 0) "
                "OR (source_mandate_id IS NOT NULL AND COALESCE(network_distance, 0) > 0)",
            )

    if _has_table("mandate_resource_scopes"):
        checks = _check_constraints("mandate_resource_scopes")
        uniques = _unique_constraints("mandate_resource_scopes")
        if "ck_mandate_resource_scopes_position_nonnegative" not in checks:
            op.create_check_constraint(
                "ck_mandate_resource_scopes_position_nonnegative",
                "mandate_resource_scopes",
                "position >= 0",
            )
        if "uq_mandate_resource_scopes_scope" not in uniques:
            op.create_unique_constraint(
                "uq_mandate_resource_scopes_scope",
                "mandate_resource_scopes",
                ["mandate_id", "resource_scope"],
            )

    if _has_table("mandate_action_scopes"):
        checks = _check_constraints("mandate_action_scopes")
        uniques = _unique_constraints("mandate_action_scopes")
        if "ck_mandate_action_scopes_position_nonnegative" not in checks:
            op.create_check_constraint(
                "ck_mandate_action_scopes_position_nonnegative",
                "mandate_action_scopes",
                "position >= 0",
            )
        if "uq_mandate_action_scopes_scope" not in uniques:
            op.create_unique_constraint(
                "uq_mandate_action_scopes_scope",
                "mandate_action_scopes",
                ["mandate_id", "action_scope"],
            )

    if _has_table("mandate_context_tags"):
        checks = _check_constraints("mandate_context_tags")
        uniques = _unique_constraints("mandate_context_tags")
        if "ck_mandate_context_tags_position_nonnegative" not in checks:
            op.create_check_constraint(
                "ck_mandate_context_tags_position_nonnegative",
                "mandate_context_tags",
                "position >= 0",
            )
        if "uq_mandate_context_tags_tag" not in uniques:
            op.create_unique_constraint(
                "uq_mandate_context_tags_tag",
                "mandate_context_tags",
                ["mandate_id", "context_tag"],
            )

    if _has_table("delegation_edge_tags"):
        checks = _check_constraints("delegation_edge_tags")
        uniques = _unique_constraints("delegation_edge_tags")
        if "ck_delegation_edge_tags_position_nonnegative" not in checks:
            op.create_check_constraint(
                "ck_delegation_edge_tags_position_nonnegative",
                "delegation_edge_tags",
                "position >= 0",
            )
        if "uq_delegation_edge_tags_tag" not in uniques:
            op.create_unique_constraint(
                "uq_delegation_edge_tags_tag",
                "delegation_edge_tags",
                ["edge_id", "context_tag"],
            )

    if _has_table("authority_event_attributes"):
        checks = _check_constraints("authority_event_attributes")
        uniques = _unique_constraints("authority_event_attributes")
        if "ck_authority_event_attributes_position_nonnegative" not in checks:
            op.create_check_constraint(
                "ck_authority_event_attributes_position_nonnegative",
                "authority_event_attributes",
                "position >= 0",
            )
        if "ck_authority_event_attributes_value_type" not in checks:
            op.create_check_constraint(
                "ck_authority_event_attributes_value_type",
                "authority_event_attributes",
                "value_type IN ('str','int','float','bool','null','json')",
            )
        if "uq_authority_event_attributes_key" not in uniques:
            op.create_unique_constraint(
                "uq_authority_event_attributes_key",
                "authority_event_attributes",
                ["event_id", "attribute_key"],
            )

    if _has_table("principal_capability_grants"):
        uniques = _unique_constraints("principal_capability_grants")
        if "uq_principal_capability_grants_capability" not in uniques:
            op.create_unique_constraint(
                "uq_principal_capability_grants_capability",
                "principal_capability_grants",
                ["principal_id", "capability"],
            )

    if _has_table("principal_workload_bindings"):
        uniques = _unique_constraints("principal_workload_bindings")
        if "uq_principal_workload_bindings_workload" not in uniques:
            op.create_unique_constraint(
                "uq_principal_workload_bindings_workload",
                "principal_workload_bindings",
                ["principal_id", "workload", "binding_type"],
            )


def downgrade() -> None:
    if _has_table("principal_workload_bindings"):
        uniques = _unique_constraints("principal_workload_bindings")
        if "uq_principal_workload_bindings_workload" in uniques:
            op.drop_constraint("uq_principal_workload_bindings_workload", "principal_workload_bindings", type_="unique")

    if _has_table("principal_capability_grants"):
        uniques = _unique_constraints("principal_capability_grants")
        if "uq_principal_capability_grants_capability" in uniques:
            op.drop_constraint("uq_principal_capability_grants_capability", "principal_capability_grants", type_="unique")

    if _has_table("authority_event_attributes"):
        uniques = _unique_constraints("authority_event_attributes")
        checks = _check_constraints("authority_event_attributes")
        if "uq_authority_event_attributes_key" in uniques:
            op.drop_constraint("uq_authority_event_attributes_key", "authority_event_attributes", type_="unique")
        if "ck_authority_event_attributes_value_type" in checks:
            op.drop_constraint("ck_authority_event_attributes_value_type", "authority_event_attributes", type_="check")
        if "ck_authority_event_attributes_position_nonnegative" in checks:
            op.drop_constraint("ck_authority_event_attributes_position_nonnegative", "authority_event_attributes", type_="check")

    if _has_table("delegation_edge_tags"):
        uniques = _unique_constraints("delegation_edge_tags")
        checks = _check_constraints("delegation_edge_tags")
        if "uq_delegation_edge_tags_tag" in uniques:
            op.drop_constraint("uq_delegation_edge_tags_tag", "delegation_edge_tags", type_="unique")
        if "ck_delegation_edge_tags_position_nonnegative" in checks:
            op.drop_constraint("ck_delegation_edge_tags_position_nonnegative", "delegation_edge_tags", type_="check")

    if _has_table("mandate_context_tags"):
        uniques = _unique_constraints("mandate_context_tags")
        checks = _check_constraints("mandate_context_tags")
        if "uq_mandate_context_tags_tag" in uniques:
            op.drop_constraint("uq_mandate_context_tags_tag", "mandate_context_tags", type_="unique")
        if "ck_mandate_context_tags_position_nonnegative" in checks:
            op.drop_constraint("ck_mandate_context_tags_position_nonnegative", "mandate_context_tags", type_="check")

    if _has_table("mandate_action_scopes"):
        uniques = _unique_constraints("mandate_action_scopes")
        checks = _check_constraints("mandate_action_scopes")
        if "uq_mandate_action_scopes_scope" in uniques:
            op.drop_constraint("uq_mandate_action_scopes_scope", "mandate_action_scopes", type_="unique")
        if "ck_mandate_action_scopes_position_nonnegative" in checks:
            op.drop_constraint("ck_mandate_action_scopes_position_nonnegative", "mandate_action_scopes", type_="check")

    if _has_table("mandate_resource_scopes"):
        uniques = _unique_constraints("mandate_resource_scopes")
        checks = _check_constraints("mandate_resource_scopes")
        if "uq_mandate_resource_scopes_scope" in uniques:
            op.drop_constraint("uq_mandate_resource_scopes_scope", "mandate_resource_scopes", type_="unique")
        if "ck_mandate_resource_scopes_position_nonnegative" in checks:
            op.drop_constraint("ck_mandate_resource_scopes_position_nonnegative", "mandate_resource_scopes", type_="check")

    if _has_table("execution_mandates"):
        checks = _check_constraints("execution_mandates")
        if "ck_execution_mandates_source_distance" in checks:
            op.drop_constraint("ck_execution_mandates_source_distance", "execution_mandates", type_="check")
        if "ck_execution_mandates_network_distance_nonnegative" in checks:
            op.drop_constraint("ck_execution_mandates_network_distance_nonnegative", "execution_mandates", type_="check")
        if "ck_execution_mandates_valid_window" in checks:
            op.drop_constraint("ck_execution_mandates_valid_window", "execution_mandates", type_="check")

    if _has_table("principal_key_custody"):
        checks = _check_constraints("principal_key_custody")
        if "ck_principal_key_custody_backend" in checks:
            op.drop_constraint("ck_principal_key_custody_backend", "principal_key_custody", type_="check")

    if _has_table("principals"):
        checks = _check_constraints("principals")
        if "ck_principals_attestation_status_values" in checks:
            op.drop_constraint("ck_principals_attestation_status_values", "principals", type_="check")
        if "ck_principals_lifecycle_status_values" in checks:
            op.drop_constraint("ck_principals_lifecycle_status_values", "principals", type_="check")
        if "ck_principals_source_not_self" in checks:
            op.drop_constraint("ck_principals_source_not_self", "principals", type_="check")
