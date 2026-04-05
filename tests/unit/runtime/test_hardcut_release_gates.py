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
