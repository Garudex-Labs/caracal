"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Parity checks for principal registration call shape across CLI and TUI.
"""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace

import pytest
from click.testing import CliRunner
from rich.console import Console

import caracal.cli.principal as principal_cli
import caracal.flow.screens.principal_flow as principal_flow
from caracal.identity.service import IdentityService


class _SessionScopeStub:
    def __enter__(self):
        return object()

    def __exit__(self, exc_type, exc, tb):
        return False


class _DBManagerStub:
    def __init__(self) -> None:
        self.closed = False

    def session_scope(self):
        return _SessionScopeStub()

    def close(self) -> None:
        self.closed = True


class _CliIdentityServiceSpy:
    captured_kwargs: dict = {}

    def __init__(self, principal_registry):
        self.principal_registry = principal_registry

    def register_principal(self, **kwargs):
        type(self).captured_kwargs = dict(kwargs)
        return SimpleNamespace(
            principal_id="principal-cli",
            name=kwargs["name"],
            principal_kind=kwargs["principal_kind"],
            owner=kwargs["owner"],
            created_at="2026-01-01T00:00:00Z",
            metadata={"vault_key_ref": "vault://caracal/runtime/principal-cli"},
        )


class _FlowIdentityServiceSpy:
    captured_kwargs: dict = {}

    def __init__(self, principal_registry):
        self.principal_registry = principal_registry

    def register_principal(self, **kwargs):
        type(self).captured_kwargs = dict(kwargs)
        return SimpleNamespace(
            principal_id="principal-flow",
            name=kwargs["name"],
            principal_kind=kwargs["principal_kind"],
            owner=kwargs["owner"],
            created_at="2026-01-01T00:00:00Z",
            metadata={"vault_key_ref": "vault://caracal/runtime/principal-flow"},
        )


class _SDKRegistrySpy:
    captured_kwargs: dict = {}

    def register_principal(self, **kwargs):
        type(self).captured_kwargs = dict(kwargs)
        return SimpleNamespace(
            principal_id="principal-sdk",
            name=kwargs["name"],
            principal_kind=kwargs["principal_kind"],
            owner=kwargs["owner"],
            created_at="2026-01-01T00:00:00Z",
            metadata=kwargs.get("metadata") or {},
        )


class _PromptStub:
    def __init__(self, *, name: str, owner: str, principal_kind: str = "orchestrator") -> None:
        self._name = name
        self._owner = owner
        self._principal_kind = principal_kind

    def select(self, *_args, **_kwargs):
        return self._principal_kind

    def text(self, label: str, **_kwargs):
        if label == "Principal name":
            return self._name
        if label == "Owner email":
            return self._owner
        raise AssertionError(f"Unexpected prompt label: {label}")

    def confirm(self, *_args, **_kwargs):
        return True


@pytest.mark.unit
def test_cli_register_uses_identity_service_required_fields(monkeypatch) -> None:
    db_manager = _DBManagerStub()
    monkeypatch.setattr(principal_cli, "get_db_manager", lambda _config: db_manager)
    monkeypatch.setattr(principal_cli, "IdentityService", _CliIdentityServiceSpy)

    runner = CliRunner()
    result = runner.invoke(
        principal_cli.register,
        [
            "--type",
            "orchestrator",
            "--name",
            "orchestrator-cli",
            "--email",
            "cli@example.com",
            "--metadata",
            "team=ops",
        ],
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code == 0, result.output
    assert _CliIdentityServiceSpy.captured_kwargs["name"] == "orchestrator-cli"
    assert _CliIdentityServiceSpy.captured_kwargs["owner"] == "cli@example.com"
    assert _CliIdentityServiceSpy.captured_kwargs["principal_kind"] == "orchestrator"
    assert _CliIdentityServiceSpy.captured_kwargs["generate_keys"] is True
    assert db_manager.closed is True


@pytest.mark.unit
def test_tui_register_uses_identity_service_required_fields(monkeypatch) -> None:
    db_manager = _DBManagerStub()
    monkeypatch.setattr(principal_flow, "get_db_manager", lambda: db_manager)
    monkeypatch.setattr(principal_flow, "IdentityService", _FlowIdentityServiceSpy)

    flow = principal_flow.PrincipalFlow(
        console=Console(file=StringIO(), force_terminal=False, width=120)
    )
    flow.prompt = _PromptStub(name="orchestrator-flow", owner="flow@example.com")

    flow.create_principal()

    assert _FlowIdentityServiceSpy.captured_kwargs["name"] == "orchestrator-flow"
    assert _FlowIdentityServiceSpy.captured_kwargs["owner"] == "flow@example.com"
    assert _FlowIdentityServiceSpy.captured_kwargs["principal_kind"] == "orchestrator"
    assert _FlowIdentityServiceSpy.captured_kwargs["generate_keys"] is True
    assert db_manager.closed is True


def _canonical_registration_payload(kwargs: dict) -> dict:
    return {
        "name": kwargs["name"],
        "owner": kwargs["owner"],
        "principal_kind": kwargs["principal_kind"],
        "metadata": kwargs.get("metadata"),
        "generate_keys": kwargs.get("generate_keys"),
    }


@pytest.mark.unit
def test_registration_matrix_sdk_cli_tui_parity(monkeypatch) -> None:
    shared_name = "orchestrator-unified"
    shared_owner = "unified@example.com"
    shared_kind = "orchestrator"

    # SDK-facing canonical service call
    sdk_registry = _SDKRegistrySpy()
    sdk_service = IdentityService(principal_registry=sdk_registry)
    sdk_service.register_principal(
        name=shared_name,
        owner=shared_owner,
        principal_kind=shared_kind,
        metadata=None,
        generate_keys=True,
    )

    # CLI registration surface
    cli_db_manager = _DBManagerStub()
    monkeypatch.setattr(principal_cli, "get_db_manager", lambda _config: cli_db_manager)
    monkeypatch.setattr(principal_cli, "IdentityService", _CliIdentityServiceSpy)
    cli_result = CliRunner().invoke(
        principal_cli.register,
        [
            "--type",
            shared_kind,
            "--name",
            shared_name,
            "--email",
            shared_owner,
        ],
        obj=SimpleNamespace(config=object()),
    )
    assert cli_result.exit_code == 0, cli_result.output

    # TUI registration surface
    tui_db_manager = _DBManagerStub()
    monkeypatch.setattr(principal_flow, "get_db_manager", lambda: tui_db_manager)
    monkeypatch.setattr(principal_flow, "IdentityService", _FlowIdentityServiceSpy)
    flow = principal_flow.PrincipalFlow(
        console=Console(file=StringIO(), force_terminal=False, width=120)
    )
    flow.prompt = _PromptStub(name=shared_name, owner=shared_owner, principal_kind=shared_kind)
    flow.create_principal()

    sdk_payload = _canonical_registration_payload(_SDKRegistrySpy.captured_kwargs)
    cli_payload = _canonical_registration_payload(_CliIdentityServiceSpy.captured_kwargs)
    tui_payload = _canonical_registration_payload(_FlowIdentityServiceSpy.captured_kwargs)

    assert sdk_payload == cli_payload == tui_payload
    assert cli_db_manager.closed is True
    assert tui_db_manager.closed is True
