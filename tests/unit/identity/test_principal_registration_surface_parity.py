"""Parity checks for principal registration call shape across CLI and TUI."""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace

import pytest
from click.testing import CliRunner
from rich.console import Console

import caracal.cli.principal as principal_cli
import caracal.flow.screens.principal_flow as principal_flow


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
            metadata={"vault_key_ref": "vault://caracal/runtime/principal-flow"},
        )


class _PromptStub:
    def select(self, *_args, **_kwargs):
        return "worker"

    def text(self, label: str, **_kwargs):
        if label == "Principal name":
            return "worker-flow"
        if label == "Owner email":
            return "flow@example.com"
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
            "worker",
            "--name",
            "worker-cli",
            "--email",
            "cli@example.com",
            "--metadata",
            "team=ops",
        ],
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code == 0, result.output
    assert _CliIdentityServiceSpy.captured_kwargs["name"] == "worker-cli"
    assert _CliIdentityServiceSpy.captured_kwargs["owner"] == "cli@example.com"
    assert _CliIdentityServiceSpy.captured_kwargs["principal_kind"] == "worker"
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
    flow.prompt = _PromptStub()

    flow.create_principal()

    assert _FlowIdentityServiceSpy.captured_kwargs["name"] == "worker-flow"
    assert _FlowIdentityServiceSpy.captured_kwargs["owner"] == "flow@example.com"
    assert _FlowIdentityServiceSpy.captured_kwargs["principal_kind"] == "worker"
    assert _FlowIdentityServiceSpy.captured_kwargs["generate_keys"] is True
    assert db_manager.closed is True
