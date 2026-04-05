"""Release-gate tests that prevent hard-cut regressions."""

from __future__ import annotations

from pathlib import Path

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
