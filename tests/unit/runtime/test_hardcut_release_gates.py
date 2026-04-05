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
def test_runtime_compose_has_no_file_backed_state_markers() -> None:
    compose_file = _REPO_ROOT / "deploy" / "docker-compose.yml"
    payload = compose_file.read_text(encoding="utf-8").lower()

    assert "caracal_state:" not in payload
    assert "/home/caracal/.caracal" not in payload


@pytest.mark.unit
def test_core_crypto_module_has_no_private_key_sign_helpers() -> None:
    crypto_file = _REPO_ROOT / "caracal" / "core" / "crypto.py"
    payload = crypto_file.read_text(encoding="utf-8")

    assert "def sign_mandate(" not in payload
    assert "def sign_merkle_root(" not in payload


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
    assert "Local Merkle key-file commands are disabled in hard-cut mode." in cli_payload


@pytest.mark.unit
def test_db_models_have_no_legacy_sync_state_orm_classes() -> None:
    models_file = _REPO_ROOT / "caracal" / "db" / "models.py"
    payload = models_file.read_text(encoding="utf-8")

    assert "class SyncOperation(" not in payload
    assert "class SyncConflict(" not in payload
    assert "class SyncMetadata(" not in payload


@pytest.mark.unit
def test_sync_compatibility_modules_have_no_sync_state_orm_imports() -> None:
    sync_engine_file = _REPO_ROOT / "caracal" / "deployment" / "sync_engine.py"
    sync_state_file = _REPO_ROOT / "caracal" / "deployment" / "sync_state.py"

    combined = "\n".join(
        [
            sync_engine_file.read_text(encoding="utf-8"),
            sync_state_file.read_text(encoding="utf-8"),
        ]
    )

    assert "from caracal.db.models import Sync" not in combined


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
