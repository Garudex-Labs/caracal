"""Release-gate tests that prevent hard-cut regressions."""

from __future__ import annotations

from pathlib import Path
import re

import pytest


_REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.unit
def test_identity_module_has_no_legacy_alias_exports() -> None:
    identity_file = _REPO_ROOT / "caracal" / "core" / "identity.py"
    payload = identity_file.read_text(encoding="utf-8")

    assert "AgentRegistry =" not in payload
    assert "AgentIdentity =" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_legacy_agent_identity_imports() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if "from caracal.core.identity import Agent" in payload:
            offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_has_no_sqlite_url_usages() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        if py_file.name == "hardcut_preflight.py":
            continue

        payload = py_file.read_text(encoding="utf-8").lower()
        if "sqlite://" in payload or "sqlite+" in payload:
            offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_hardcut_preflight_freezes_canonical_contract_constants() -> None:
    preflight_file = _REPO_ROOT / "caracal" / "runtime" / "hardcut_preflight.py"
    payload = preflight_file.read_text(encoding="utf-8")

    assert '_CANONICAL_ENTERPRISE_API_FAMILY = "/api/sync"' in payload
    assert '_CANONICAL_ENTERPRISE_CLI_FAMILY = "caracal enterprise"' in payload
    assert "_FORBIDDEN_SYNC_RUNTIME_MODEL_MARKERS" in payload


@pytest.mark.unit
def test_runtime_session_signing_has_no_legacy_env_alias_fallback() -> None:
    entrypoints_file = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    preflight_file = _REPO_ROOT / "caracal" / "runtime" / "hardcut_preflight.py"

    entrypoints_payload = entrypoints_file.read_text(encoding="utf-8")
    preflight_payload = preflight_file.read_text(encoding="utf-8")

    assert "AIS_SESSION_ALGORITHM_FALLBACK_ENV" not in entrypoints_payload
    assert "CARACAL_SESSION_JWT_ALGORITHM" not in entrypoints_payload
    assert "CARACAL_SESSION_JWT_ALGORITHM" in preflight_payload


@pytest.mark.unit
def test_runtime_compose_has_no_file_backed_state_markers() -> None:
    compose_files = (
        _REPO_ROOT / "deploy" / "docker-compose.yml",
        _REPO_ROOT / "deploy" / "docker-compose.image.yml",
    )

    for compose_file in compose_files:
        payload = compose_file.read_text(encoding="utf-8").lower()
        assert "caracal_state:" not in payload, str(compose_file)
        assert "/home/caracal/.caracal" not in payload, str(compose_file)


@pytest.mark.unit
def test_runtime_image_compose_has_vault_sidecar_and_hardcut_env_markers() -> None:
    compose_file = _REPO_ROOT / "deploy" / "docker-compose.image.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "  vault:" in payload
    assert "CARACAL_PRINCIPAL_KEY_BACKEND" in payload
    assert "CARACAL_VAULT_URL" in payload
    assert "CARACAL_VAULT_SESSION_PUBLIC_KEY_REF" in payload
    assert "CARACAL_SESSION_SIGNING_ALGORITHM" in payload


@pytest.mark.unit
def test_enterprise_compose_has_vault_sidecar_and_no_aws_or_null_backend_defaults() -> None:
    compose_file = _REPO_ROOT / ".." / "caracalEnterprise" / "docker-compose.enterprise.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "  vault:" in payload
    assert "infisical/infisical:latest" in payload
    assert "CARACAL_PRINCIPAL_KEY_BACKEND=${CARACAL_PRINCIPAL_KEY_BACKEND:-vault}" in payload
    assert "CARACAL_VAULT_URL=${CARACAL_VAULT_URL:-http://vault:8080}" in payload
    assert "CARACAL_SECRET_BACKEND" not in payload
    assert "VAULT_ADDR" not in payload
    assert "VAULT_ROLE_ID" not in payload
    assert "VAULT_SECRET_ID" not in payload
    assert "AWS_REGION" not in payload
    assert "AWS_ACCESS_KEY_ID" not in payload
    assert "AWS_SECRET_ACCESS_KEY" not in payload
    assert ":-null" not in payload


@pytest.mark.unit
def test_enterprise_compose_uses_separate_vault_topology_defaults_from_oss_runtime() -> None:
    compose_file = _REPO_ROOT / ".." / "caracalEnterprise" / "docker-compose.enterprise.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "${CARACAL_ENTERPRISE_VAULT_PORT:-8180}:8080" in payload
    assert "CARACAL_VAULT_TOKEN=${CARACAL_VAULT_TOKEN:-enterprise-local-token}" in payload
    assert "CARACAL_VAULT_PROJECT_ID=${CARACAL_VAULT_PROJECT_ID:-caracal-enterprise-local}" in payload
    assert "CARACAL_VAULT_ENVIRONMENT=${CARACAL_VAULT_ENVIRONMENT:-enterprise-dev}" in payload
    assert "CARACAL_VAULT_SECRET_PATH=${CARACAL_VAULT_SECRET_PATH:-/enterprise}" in payload


@pytest.mark.unit
def test_enterprise_startup_local_infra_boots_vault_sidecar() -> None:
    main_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "main.py"
    payload = main_file.read_text(encoding="utf-8")

    assert '"up", "-d", "redis", "postgres", "vault"' in payload
    assert '{"postgres", "redis", "vault"}' in payload
    assert "5433/6380/8180" in payload


@pytest.mark.unit
def test_oss_env_example_uses_vault_only_hardcut_defaults() -> None:
    env_example = _REPO_ROOT / ".env.example"
    payload = env_example.read_text(encoding="utf-8")

    assert "CARACAL_PRINCIPAL_KEY_BACKEND=vault" in payload
    assert "CARACAL_VAULT_SIDECAR_IMAGE=infisical/infisical:latest" in payload
    assert "CARACAL_SECRET_BACKEND" not in payload
    assert "AWS_" not in payload
    assert "aws_kms" not in payload.lower()


@pytest.mark.unit
def test_enterprise_schema_hardcut_removes_bootstrap_sql_and_license_password_hash_artifact() -> None:
    bootstrap_sql = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "create_caracal_tables.sql"
    migration_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "alembic" / "versions" / "029_drop_license_password_hash_hardcut.py"
    migration_payload = migration_file.read_text(encoding="utf-8")

    assert not bootstrap_sql.exists()
    assert 'revision: str = "029"' in migration_payload
    assert 'down_revision: Union[str, None] = "028"' in migration_payload
    assert 'op.drop_column("licenses", "password_hash")' in migration_payload


@pytest.mark.unit
def test_core_crypto_module_has_no_private_key_sign_helpers() -> None:
    crypto_file = _REPO_ROOT / "caracal" / "core" / "crypto.py"
    payload = crypto_file.read_text(encoding="utf-8")

    assert "def sign_mandate(" not in payload
    assert "def sign_merkle_root(" not in payload


@pytest.mark.unit
def test_session_manager_signing_routes_only_through_signer_abstraction() -> None:
    session_manager_file = _REPO_ROOT / "caracal" / "core" / "session_manager.py"
    payload = session_manager_file.read_text(encoding="utf-8")

    assert "self._token_signer.sign_token(" in payload
    assert "self._signing_key" not in payload
    assert "jwt.encode(" not in payload


@pytest.mark.unit
def test_vault_module_has_no_legacy_private_key_compatibility_helpers() -> None:
    vault_file = _REPO_ROOT / "caracal" / "core" / "vault.py"
    payload = vault_file.read_text(encoding="utf-8")

    assert "MasterKeyProvider" not in payload
    assert "CARACAL_VAULT_MEK_SECRET" not in payload
    assert "_load_private_key(" not in payload
    assert "private_bytes(" not in payload
    assert "load_pem_private_key" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_core_crypto_sign_helper_imports() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    forbidden_import_markers = (
        "from caracal.core.crypto import sign_mandate",
        "from caracal.core.crypto import sign_merkle_root",
    )
    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_import_markers):
            offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_runtime_and_cli_gateway_resolution_is_centralized_in_edition_adapter() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []
    forbidden_markers = (
        'os.environ.get("CARACAL_ENTERPRISE_URL")',
        'os.environ.get("CARACAL_GATEWAY_ENDPOINT")',
        'os.environ.get("CARACAL_GATEWAY_URL")',
    )
    allowed_files = {
        "caracal/deployment/edition.py",
        "caracal/runtime/hardcut_preflight.py",
    }

    for py_file in source_root.rglob("*.py"):
        relative_path = py_file.relative_to(_REPO_ROOT).as_posix()
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_feature_modules_do_not_branch_on_is_enterprise_directly() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []
    allowed_files = {
        "caracal/deployment/edition.py",
        "caracal/deployment/edition_adapter.py",
    }

    for py_file in source_root.rglob("*.py"):
        relative_path = py_file.relative_to(_REPO_ROOT).as_posix()
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if ".is_enterprise()" in payload:
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_enterprise_license_validation_has_no_offline_acceptance_fallback() -> None:
    license_file = _REPO_ROOT / "caracal" / "enterprise" / "license.py"
    payload = license_file.read_text(encoding="utf-8")

    assert "validated from cache" not in payload
    assert "trying cached license" not in payload
    assert "falling back to cached license" not in payload
    assert "CARACAL_ENTERPRISE_API_URL" not in payload
    assert "password_protected" not in payload


@pytest.mark.unit
def test_gateway_flow_has_no_hidden_auto_sync_path() -> None:
    gateway_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "gateway_flow.py"
    payload = gateway_flow_file.read_text(encoding="utf-8")

    assert "_auto_sync_gateway_if_needed" not in payload
    assert "Gateway auto-sync attempt failed" not in payload


@pytest.mark.unit
def test_gateway_features_resolve_gateway_endpoint_through_edition_adapter() -> None:
    gateway_features_file = _REPO_ROOT / "caracal" / "core" / "gateway_features.py"
    payload = gateway_features_file.read_text(encoding="utf-8")

    assert "get_deployment_edition_adapter" in payload
    assert "resolve_gateway_feature_overrides" in payload
    assert "load_enterprise_config" not in payload
    assert "CARACAL_ENTERPRISE_URL" not in payload
    assert "CARACAL_GATEWAY_ENDPOINT" not in payload
    assert "CARACAL_GATEWAY_URL" not in payload


@pytest.mark.unit
def test_core_and_runtime_modules_do_not_import_enterprise_license_directly() -> None:
    source_roots = (
        _REPO_ROOT / "caracal" / "core",
        _REPO_ROOT / "caracal" / "runtime",
    )
    offenders: list[str] = []
    forbidden_markers = (
        "from caracal.enterprise.license import",
        "import caracal.enterprise.license",
    )

    for source_root in source_roots:
        for py_file in source_root.rglob("*.py"):
            payload = py_file.read_text(encoding="utf-8")
            if any(marker in payload for marker in forbidden_markers):
                offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_enterprise_connect_flow_has_no_implicit_gateway_sync_or_auto_sync_copy() -> None:
    enterprise_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "enterprise_flow.py"
    payload = enterprise_flow_file.read_text(encoding="utf-8")

    assert "pull_gateway_config()" not in payload
    assert "automatic sync" not in payload.lower()
    assert "Gateway auto-configured" not in payload
    assert "Enter license password" not in payload
    assert "password=" not in payload


@pytest.mark.unit
def test_mandate_manager_uses_signing_service_for_signature_generation() -> None:
    mandate_file = _REPO_ROOT / "caracal" / "core" / "mandate.py"
    payload = mandate_file.read_text(encoding="utf-8")

    assert "sign_canonical_payload_for_principal(" in payload
    assert "from caracal.core.crypto import sign_mandate" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_direct_registry_register_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")

        # Core registry implementation is allowed to define registration internals.
        if py_file.relative_to(_REPO_ROOT).as_posix() in {
            "caracal/core/identity.py",
            "caracal/identity/service.py",
        }:
            continue

        if "registry.register_principal(" in payload:
            offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_uses_identity_service_for_registration_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    allowed_files = {
        "caracal/core/identity.py",
        "caracal/identity/service.py",
    }
    disallowed_pattern = re.compile(r"\b(?!identity_service\b)[A-Za-z_][A-Za-z0-9_]*\.register_principal\(")

    for py_file in source_root.rglob("*.py"):
        relative_path = py_file.relative_to(_REPO_ROOT).as_posix()
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if disallowed_pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_uses_identity_service_for_spawn_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    allowed_files = {
        "caracal/identity/service.py",
        "caracal/identity/ais_server.py",
    }
    disallowed_pattern = re.compile(r"\b(?!identity_service\b)[A-Za-z_][A-Za-z0-9_]*\.spawn_principal\(")

    for py_file in source_root.rglob("*.py"):
        relative_path = py_file.relative_to(_REPO_ROOT).as_posix()
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if disallowed_pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_enterprise_code_has_no_direct_registry_or_spawn_manager_usage() -> None:
    enterprise_root = _REPO_ROOT / "caracal" / "enterprise"
    offenders: list[str] = []

    forbidden_markers = (
        "PrincipalRegistry(",
        "SpawnManager(",
        ".register_principal(",
        ".spawn_principal(",
        "from caracal.core.identity import PrincipalRegistry",
        "from caracal.core.spawn import SpawnManager",
    )

    for py_file in enterprise_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(str(py_file.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_forbidden_marker_scanner_covers_phase_13_hardcut_expansion() -> None:
    scanner_file = _REPO_ROOT / "scripts" / "hardcut_forbidden_marker_scan.py"
    payload = scanner_file.read_text(encoding="utf-8")

    assert "legacy_sync_auth_surfaces" in payload
    assert "compatibility_env_aliases" in payload
    assert "enterprise_logic_leakage" in payload
    assert "combined_onboarding_setup_helpers" in payload
    assert "stale_removed_surface_names" in payload
    assert "fallback_gateway_env_aliases" in payload
    assert "split_mode_markers" in payload
    assert "single_lineage_residuals" in payload
    assert "transitional_architecture_markers" in payload
    assert "CARACAL_SESSION_JWT_ALGORITHM" in payload
    assert "owner_phase" in payload
    assert "_gate_missing_repo_violations" in payload


@pytest.mark.unit
def test_enterprise_sync_client_has_no_payload_or_query_auth_fallbacks() -> None:
    sync_file = _REPO_ROOT / "caracal" / "enterprise" / "sync.py"
    payload = sync_file.read_text(encoding="utf-8")

    assert 'payload["sync_api_key"]' not in payload
    assert 'payload["license_key"]' not in payload
    assert "?license_key=" not in payload


@pytest.mark.unit
def test_revocation_webhook_publisher_has_single_sync_header_strategy() -> None:
    publisher_file = _REPO_ROOT / "caracal" / "core" / "revocation_publishers.py"
    payload = publisher_file.read_text(encoding="utf-8")

    assert '"X-Sync-Api-Key": self._sync_api_key' in payload
    assert "bearer_token" not in payload
    assert 'headers["Authorization"]' not in payload


@pytest.mark.unit
def test_runtime_ais_handlers_are_not_stubbed() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert "AIS runtime handlers are not wired" not in payload


@pytest.mark.unit
def test_signing_service_uses_vault_reference_not_raw_private_key_resolution() -> None:
    signing_service_file = _REPO_ROOT / "caracal" / "core" / "signing_service.py"
    payload = signing_service_file.read_text(encoding="utf-8")

    assert "get_signing_key_reference(" in payload
    assert "resolve_private_key(" not in payload
    assert "load_pem_private_key(" not in payload


@pytest.mark.unit
def test_embedded_runtime_compose_includes_vault_sidecar() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert "CARACAL_VAULT_SIDECAR_IMAGE" in payload
    assert "CARACAL_VAULT_URL" in payload
    assert "vault:" in payload
    assert "/home/caracal/.caracal" not in payload


@pytest.mark.unit
def test_runtime_host_up_pulls_and_starts_vault_sidecar() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert 'pull_services = ["postgres", "redis", "vault"]' in payload
    assert '[*up_cmd, "postgres", "redis", "vault", "mcp"]' in payload


@pytest.mark.unit
def test_runtime_host_flow_starts_vault_sidecar() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert 'compose_cmd + ["up", "-d", "postgres", "redis", "vault"]' in payload


@pytest.mark.unit
def test_config_manager_has_no_local_secret_storage_markers() -> None:
    config_manager_file = _REPO_ROOT / "caracal" / "deployment" / "config_manager.py"
    payload = config_manager_file.read_text(encoding="utf-8")

    assert "secrets.vault" not in payload
    assert "CARACAL_CONFIG_ENCRYPTION_KEY" not in payload
    assert "aead_v1:" not in payload


@pytest.mark.unit
def test_operator_secret_surfaces_have_no_aws_secret_backend_copy() -> None:
    secrets_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "secrets_flow.py"
    secrets_cli_file = _REPO_ROOT / "caracal" / "cli" / "secrets.py"
    enterprise_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "enterprise_flow.py"

    combined = "\n".join(
        [
            secrets_flow_file.read_text(encoding="utf-8"),
            secrets_cli_file.read_text(encoding="utf-8"),
            enterprise_flow_file.read_text(encoding="utf-8"),
        ]
    )

    assert "AWS Secrets Manager" not in combined
    assert "AWS SM" not in combined


@pytest.mark.unit
def test_principal_key_helpers_have_no_raw_private_key_resolution_api() -> None:
    principal_keys_file = _REPO_ROOT / "caracal" / "core" / "principal_keys.py"
    payload = principal_keys_file.read_text(encoding="utf-8")

    assert "def resolve_principal_private_key(" not in payload
    assert "def store_principal_private_key(" not in payload
    assert "def backup_local_private_key(" not in payload
    assert "ec.generate_private_key(" not in payload
    assert "private_bytes(" not in payload


@pytest.mark.unit
def test_delegation_manager_has_no_private_key_generation_helper() -> None:
    delegation_file = _REPO_ROOT / "caracal" / "core" / "delegation.py"
    payload = delegation_file.read_text(encoding="utf-8")

    assert "def generate_key_pair(" not in payload


@pytest.mark.unit
def test_merkle_config_and_cli_enforce_hardcut_vault_guard() -> None:
    settings_file = _REPO_ROOT / "caracal" / "config" / "settings.py"
    merkle_cli_file = _REPO_ROOT / "caracal" / "cli" / "merkle.py"

    settings_payload = settings_file.read_text(encoding="utf-8")
    cli_payload = merkle_cli_file.read_text(encoding="utf-8")

    assert "CARACAL_VAULT_MERKLE_SIGNING_KEY_REF" in settings_payload
    assert "CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF" in settings_payload
    assert "Local file-backed Merkle signing is forbidden." in settings_payload
    assert "Local Merkle key-file commands are disabled in runtime paths." in cli_payload


@pytest.mark.unit
def test_db_models_have_no_legacy_sync_state_orm_classes() -> None:
    models_file = _REPO_ROOT / "caracal" / "db" / "models.py"
    payload = models_file.read_text(encoding="utf-8")

    assert "class SyncOperation(" not in payload
    assert "class SyncConflict(" not in payload
    assert "class SyncMetadata(" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_legacy_sync_state_table_markers() -> None:
    source_root = _REPO_ROOT / "caracal"
    allowed_files = {
        "caracal/db/schema_version.py",
        "caracal/runtime/hardcut_preflight.py",
    }
    allowed_prefixes = (
        "caracal/db/migrations/versions/",
    )
    offenders: list[str] = []

    pattern = re.compile(r"\bsync_(operations|conflicts|metadata)\b")

    for py_file in source_root.rglob("*.py"):
        relative_path = py_file.relative_to(_REPO_ROOT).as_posix()
        if relative_path in allowed_files or relative_path.startswith(allowed_prefixes):
            continue

        payload = py_file.read_text(encoding="utf-8")
        if pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_legacy_sync_modules_are_removed() -> None:
    sync_engine_file = _REPO_ROOT / "caracal" / "deployment" / "sync_engine.py"
    sync_state_file = _REPO_ROOT / "caracal" / "deployment" / "sync_state.py"

    assert not sync_engine_file.exists()
    assert not sync_state_file.exists()


@pytest.mark.unit
def test_main_cli_uses_enterprise_group_and_has_no_top_level_sync_group() -> None:
    main_cli_file = _REPO_ROOT / "caracal" / "cli" / "main.py"
    payload = main_cli_file.read_text(encoding="utf-8")

    assert "def enterprise(ctx):" in payload
    assert "enterprise.add_command(enterprise_login, name='login')" in payload
    assert "enterprise.add_command(enterprise_disconnect, name='disconnect')" in payload
    assert "enterprise.add_command(enterprise_sync, name='sync')" in payload
    assert "enterprise.add_command(enterprise_status, name='status')" in payload
    assert "def sync(ctx):" not in payload
    assert "caracal sync " not in payload


@pytest.mark.unit
def test_deployment_cli_has_hardcut_enterprise_commands_only() -> None:
    deployment_cli_file = _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py"
    payload = deployment_cli_file.read_text(encoding="utf-8")

    assert "@click.group(name=\"sync\")" not in payload
    assert "@enterprise_group.command(name=\"login\")" in payload
    assert "@enterprise_group.command(name=\"disconnect\")" in payload
    assert "@enterprise_group.command(name=\"sync\")" in payload
    assert "@enterprise_group.command(name=\"status\")" in payload
    assert "enterprise_group.command(name=\"conflicts\")" not in payload
    assert "enterprise_group.command(name=\"auto-enable\")" not in payload
    assert "enterprise_group.command(name=\"auto-disable\")" not in payload


@pytest.mark.unit
def test_flow_sync_monitor_screen_is_removed() -> None:
    sync_monitor_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "sync_monitor.py"
    assert not sync_monitor_file.exists()


@pytest.mark.unit
def test_config_manager_has_no_sync_workspace_fields() -> None:
    config_manager_file = _REPO_ROOT / "caracal" / "deployment" / "config_manager.py"
    payload = config_manager_file.read_text(encoding="utf-8")

    assert "sync_enabled" not in payload
    assert "sync_url" not in payload
    assert "sync_direction" not in payload
    assert "auto_sync_interval" not in payload
    assert "conflict_strategy" not in payload


@pytest.mark.unit
def test_edition_detection_has_no_sync_or_license_backdoor_markers() -> None:
    edition_file = _REPO_ROOT / "caracal" / "deployment" / "edition.py"
    payload = edition_file.read_text(encoding="utf-8")

    assert "sync-enabled workspace" not in payload
    assert "enterprise license state" not in payload
    assert "edition_detected_enterprise_license" not in payload
    assert "edition_license_detection_failed" not in payload
    assert "sync_api_key" not in payload


@pytest.mark.unit
def test_connector_docs_use_enterprise_command_path_only() -> None:
    docs_file = _REPO_ROOT / "docs" / "content" / "open-source" / "developers" / "enterprise-connector" / "index.mdx"
    payload = docs_file.read_text(encoding="utf-8")

    assert "caracal enterprise login <url> <token>" in payload
    assert "caracal enterprise status" in payload
    assert "caracal enterprise sync" in payload
    assert "caracal enterprise disconnect" in payload
    assert "caracal sync " not in payload


@pytest.mark.unit
def test_flow_tui_docs_have_no_sync_monitor_reference() -> None:
    docs_file = _REPO_ROOT / "docs" / "content" / "open-source" / "developers" / "flow-tui" / "index.mdx"
    payload = docs_file.read_text(encoding="utf-8")

    assert "sync monitor" not in payload.lower()


@pytest.mark.unit
def test_python_sdk_sync_uses_api_sync_path_only() -> None:
    authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "authority_client.py"
    async_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "async_authority_client.py"

    payload = "\n".join(
        [
            authority_client.read_text(encoding="utf-8"),
            async_authority_client.read_text(encoding="utf-8"),
        ]
    )

    assert "/api/sync" in payload
    assert "/api/connection/sync" not in payload


@pytest.mark.unit
def test_async_python_sdk_has_no_legacy_sync_metadata_helper() -> None:
    async_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "async_authority_client.py"
    payload = async_authority_client.read_text(encoding="utf-8")

    assert "def sync_metadata(" not in payload
    assert "metadata sync" not in payload.lower()


@pytest.mark.unit
def test_sdk_sync_extension_stubs_are_removed() -> None:
    python_sync_stub = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "enterprise" / "sync.py"
    node_sync_stub = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "enterprise" / "sync.ts"
    python_enterprise_init = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "enterprise" / "__init__.py"
    node_enterprise_index = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "enterprise" / "index.ts"
    enterprise_facade = _REPO_ROOT / "caracal" / "enterprise" / "__init__.py"

    assert not python_sync_stub.exists()
    assert not node_sync_stub.exists()

    python_payload = python_enterprise_init.read_text(encoding="utf-8")
    node_payload = node_enterprise_index.read_text(encoding="utf-8")
    facade_payload = enterprise_facade.read_text(encoding="utf-8")

    assert "SyncExtension" not in python_payload
    assert "SyncExtension" not in node_payload
    assert "SyncExtension" not in facade_payload


@pytest.mark.unit
def test_python_sdk_secrets_have_no_aws_fallback_markers() -> None:
    secrets_adapter = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "secrets.py"
    payload = secrets_adapter.read_text(encoding="utf-8")

    assert "boto3" not in payload
    assert "AWSSecretsManagerBackend" not in payload
    assert "_LocalAWSSecretsManagerBackend" not in payload
    assert 'return f"aws:' not in payload
    assert 'return f"caracal:' in payload


@pytest.mark.unit
def test_deployment_help_has_no_sync_engine_or_legacy_secret_storage_text() -> None:
    deployment_help_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "deployment_help.py"
    payload = deployment_help_file.read_text(encoding="utf-8")

    assert "### Sync Engine" not in payload
    assert "System keyring integration" not in payload
    assert "PBKDF2 key derivation fallback" not in payload
    assert "Age encryption for secrets" not in payload


@pytest.mark.unit
def test_sdk_sources_have_no_legacy_security_or_sync_markers() -> None:
    sdk_roots = (
        _REPO_ROOT / "sdk" / "python-sdk" / "src",
        _REPO_ROOT / "sdk" / "node-sdk" / "src",
    )
    forbidden_patterns = (
        r"\bboto3\b",
        r"\bkeyring\b",
        r"cryptography\.fernet",
        r"\bFernet\b",
        r"/api/connection\b",
        r"\bSyncExtension\b",
        r"\bcaracal_sdk\.enterprise\.sync\b",
    )

    offenders: list[str] = []
    for root in sdk_roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
                continue
            payload = path.read_text(encoding="utf-8")
            if any(re.search(pattern, payload) for pattern in forbidden_patterns):
                offenders.append(str(path.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_enterprise_frontend_secrets_surface_has_no_removed_migration_or_aws_backend_copy() -> None:
    secrets_route = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "secrets.py"
    secrets_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "secrets" / "page.tsx"
    frontend_api = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts"

    route_payload = secrets_route.read_text(encoding="utf-8")
    page_payload = secrets_page.read_text(encoding="utf-8")
    api_payload = frontend_api.read_text(encoding="utf-8")

    assert "migration_available" not in route_payload
    assert '@router.post("/migration-plan")' not in route_payload
    assert '@router.post("/migrate")' not in route_payload
    assert '@router.get("/migration-status/{migration_id}")' not in route_payload
    assert '@router.post("/downgrade-plan")' not in route_payload
    assert "MigrationWizard" not in page_payload
    assert '"migration"' not in page_payload
    assert "AWS Secrets Manager" not in page_payload
    assert "aws_secrets_manager" not in page_payload
    assert "migration-plan" not in api_payload
    assert "migration-status" not in api_payload
    assert "downgrade-plan" not in api_payload


@pytest.mark.unit
def test_enterprise_frontend_settings_copy_uses_hardcut_enterprise_commands_only() -> None:
    settings_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "settings" / "page.tsx"
    payload = settings_page.read_text(encoding="utf-8")

    assert "caracal enterprise login" not in payload
    assert "caracal enterprise sync" not in payload
    assert "generate-sync-key" not in payload
    assert "auto-sync" not in payload
    assert "Sync API key readiness" in payload


@pytest.mark.unit
def test_migration_cli_exposes_explicit_hardcut_bidirectional_commands() -> None:
    migration_cli_file = _REPO_ROOT / "caracal" / "cli" / "migration.py"
    payload = migration_cli_file.read_text(encoding="utf-8")

    assert '@migrate_group.command(name="oss-to-enterprise")' in payload
    assert '@migrate_group.command(name="enterprise-to-oss")' in payload


@pytest.mark.unit
def test_enterprise_login_disconnect_do_not_embed_credential_migration_flows() -> None:
    deployment_cli_file = _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py"
    payload = deployment_cli_file.read_text(encoding="utf-8")

    assert "--no-credential-migration" not in payload
    assert "Connected, but enterprise migration had warnings" not in payload
    assert "run `caracal migrate oss-to-enterprise`" in payload
    assert "run `caracal migrate enterprise-to-oss`" in payload
    assert "Use --allow-local-secrets-migration" not in payload


@pytest.mark.unit
def test_sdk_exports_include_management_migration_and_ais_groups() -> None:
    python_sdk_init = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "__init__.py"
    node_sdk_index = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "index.ts"

    python_payload = python_sdk_init.read_text(encoding="utf-8")
    node_payload = node_sdk_index.read_text(encoding="utf-8")

    assert 'import caracal_sdk.management as management' in python_payload
    assert 'import caracal_sdk.migration as migration' in python_payload
    assert 'import caracal_sdk.ais as ais' in python_payload
    assert "export * as management from './management'" in node_payload
    assert "export * as migration from './migration'" in node_payload
    assert "export * as ais from './ais'" in node_payload


@pytest.mark.unit
def test_sdk_clients_resolve_ais_routing_when_socket_path_is_configured() -> None:
    python_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "client.py"
    python_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "authority_client.py"
    python_async_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "async_authority_client.py"
    node_client = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "client.ts"

    combined_python = "\n".join(
        [
            python_client.read_text(encoding="utf-8"),
            python_authority_client.read_text(encoding="utf-8"),
            python_async_authority_client.read_text(encoding="utf-8"),
        ]
    )
    node_payload = node_client.read_text(encoding="utf-8")

    assert "resolve_sdk_base_url" in combined_python
    assert "CARACAL_AIS_UNIX_SOCKET_PATH" in (_REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "ais.py").read_text(encoding="utf-8")
    assert "resolveSdkBaseUrl" in node_payload


@pytest.mark.unit
def test_runtime_identity_layers_do_not_require_sdk_runtime_imports() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    identity_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"
    identity_service = _REPO_ROOT / "caracal" / "identity" / "service.py"

    combined = "\n".join(
        [
            runtime_entrypoints.read_text(encoding="utf-8"),
            identity_server.read_text(encoding="utf-8"),
            identity_service.read_text(encoding="utf-8"),
        ]
    )

    assert "caracal_sdk" not in combined
    assert "sdk/python-sdk" not in combined
    assert "sdk/node-sdk" not in combined


@pytest.mark.unit
def test_ais_runtime_binding_transport_and_refresh_contracts_are_present() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    ais_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"

    entrypoints_payload = runtime_entrypoints.read_text(encoding="utf-8")
    ais_payload = ais_server.read_text(encoding="utf-8")

    assert "startup_principal = _consume_ais_startup_attestation()" in entrypoints_payload
    assert "_complete_ais_startup_attestation(" in entrypoints_payload
    assert "validate_ais_bind_host" in ais_payload
    assert "@router.post(\"/refresh\")" in ais_payload


@pytest.mark.unit
def test_ais_runtime_has_no_credential_envelope_disk_persistence_markers() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    ais_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"

    combined = "\n".join(
        [
            runtime_entrypoints.read_text(encoding="utf-8").lower(),
            ais_server.read_text(encoding="utf-8").lower(),
        ]
    )

    assert "credential_envelope_path" not in combined
    assert "credential-envelope" not in combined
    assert "credential_envelope.json" not in combined
