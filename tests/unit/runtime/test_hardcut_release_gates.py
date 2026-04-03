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
