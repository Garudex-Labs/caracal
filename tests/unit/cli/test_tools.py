"""Unit tests for CLI tool registry commands."""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

import caracal.cli.tool_registry as tool_registry_cli


class _AdapterStub:
    def __init__(self) -> None:
        self.register_calls: list[dict[str, object]] = []
        self.deactivate_calls: list[tuple[str, str, str]] = []
        self.reactivate_calls: list[tuple[str, str, str]] = []
        self.list_calls: list[tuple[bool, str]] = []

    def register_tool(
        self,
        *,
        tool_id: str,
        active: bool,
        actor_principal_id: str,
        provider_name: str,
        resource_scope: str,
        action_scope: str,
        provider_definition_id: str,
        action_method: str,
        action_path_prefix: str,
        execution_mode: str,
        mcp_server_name: str,
        workspace_name: str,
        tool_type: str,
        handler_ref: str,
        mapping_version: str,
        allowed_downstream_scopes: list[str],
    ):
        self.register_calls.append(
            {
                "tool_id": tool_id,
                "active": active,
                "actor_principal_id": actor_principal_id,
                "provider_name": provider_name,
                "resource_scope": resource_scope,
                "action_scope": action_scope,
                "provider_definition_id": provider_definition_id,
                "action_method": action_method,
                "action_path_prefix": action_path_prefix,
                "execution_mode": execution_mode,
                "mcp_server_name": mcp_server_name,
                "workspace_name": workspace_name,
                "tool_type": tool_type,
                "handler_ref": handler_ref,
                "mapping_version": mapping_version,
                "allowed_downstream_scopes": allowed_downstream_scopes,
            }
        )
        return SimpleNamespace(tool_id=tool_id, active=active)

    def list_registered_tools(self, *, include_inactive: bool, workspace_name: str):
        self.list_calls.append((include_inactive, workspace_name))
        return [
            SimpleNamespace(tool_id="tool.active", active=True),
            SimpleNamespace(tool_id="tool.inactive", active=False),
        ]

    def deactivate_tool(self, *, tool_id: str, actor_principal_id: str, workspace_name: str):
        self.deactivate_calls.append((tool_id, actor_principal_id, workspace_name))
        return SimpleNamespace(tool_id=tool_id, active=False)

    def reactivate_tool(self, *, tool_id: str, actor_principal_id: str, workspace_name: str):
        self.reactivate_calls.append((tool_id, actor_principal_id, workspace_name))
        return SimpleNamespace(tool_id=tool_id, active=True)


@pytest.mark.unit
def test_register_command_calls_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _AdapterStub()

    @contextmanager
    def _fake_adapter(_config):
        yield adapter

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _fake_adapter)
    monkeypatch.setattr(
        tool_registry_cli,
        "ConfigManager",
        lambda: SimpleNamespace(get_default_workspace_name=lambda: "alpha"),
    )
    monkeypatch.setattr(
        tool_registry_cli,
        "load_workspace_provider_registry",
        lambda _cm, _workspace: {
            "endframe": {
                "provider_definition": "endframe",
                "definition": {
                    "resources": {
                        "deployments": {
                            "actions": {
                                "invoke": {
                                    "method": "POST",
                                    "path_prefix": "/v1/deployments",
                                }
                            }
                        }
                    }
                },
            }
        },
    )

    result = CliRunner().invoke(
        tool_registry_cli.register,
        [
            "--tool-id",
            "tool.echo",
            "--provider-name",
            "endframe",
            "--resource-id",
            "deployments",
            "--action-id",
            "invoke",
            "--provider-definition-id",
            "endframe",
            "--execution-mode",
            "mcp_forward",
            "--mcp-server-name",
            "server-0",
            "--actor-principal-id",
            "11111111-1111-1111-1111-111111111111",
        ],
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code == 0, result.output
    assert adapter.register_calls == [
        {
            "tool_id": "tool.echo",
            "active": True,
            "actor_principal_id": "11111111-1111-1111-1111-111111111111",
            "provider_name": "endframe",
            "resource_scope": "provider:endframe:resource:deployments",
            "action_scope": "provider:endframe:action:invoke",
            "provider_definition_id": "endframe",
            "action_method": "POST",
            "action_path_prefix": "/v1/deployments",
            "execution_mode": "mcp_forward",
            "mcp_server_name": "server-0",
            "workspace_name": "alpha",
            "tool_type": "direct_api",
            "handler_ref": None,
            "mapping_version": None,
            "allowed_downstream_scopes": [],
        }
    ]


@pytest.mark.unit
def test_list_command_passes_include_inactive_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _AdapterStub()

    @contextmanager
    def _fake_adapter(_config):
        yield adapter

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _fake_adapter)

    result = CliRunner().invoke(
        tool_registry_cli.list_tools,
        ["--all", "--workspace", "alpha"],
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code == 0, result.output
    assert adapter.list_calls == [(True, "alpha")]
    assert "tool.active" in result.output
    assert "tool.inactive" in result.output


@pytest.mark.unit
def test_deactivate_and_reactivate_commands_call_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _AdapterStub()

    @contextmanager
    def _fake_adapter(_config):
        yield adapter

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _fake_adapter)

    deactivate_result = CliRunner().invoke(
        tool_registry_cli.deactivate,
        [
            "--tool-id",
            "tool.echo",
            "--workspace",
            "alpha",
            "--actor-principal-id",
            "11111111-1111-1111-1111-111111111111",
        ],
        obj=SimpleNamespace(config=object()),
    )
    reactivate_result = CliRunner().invoke(
        tool_registry_cli.reactivate,
        [
            "--tool-id",
            "tool.echo",
            "--workspace",
            "alpha",
            "--actor-principal-id",
            "11111111-1111-1111-1111-111111111111",
        ],
        obj=SimpleNamespace(config=object()),
    )

    assert deactivate_result.exit_code == 0, deactivate_result.output
    assert reactivate_result.exit_code == 0, reactivate_result.output
    assert adapter.deactivate_calls == [(
        "tool.echo",
        "11111111-1111-1111-1111-111111111111",
        "alpha",
    )]
    assert adapter.reactivate_calls == [(
        "tool.echo",
        "11111111-1111-1111-1111-111111111111",
        "alpha",
    )]


@pytest.mark.unit
def test_preflight_command_passes_when_no_issues(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _AdapterStub()
    adapter.authority_evaluator = SimpleNamespace(db_session=object())
    adapter._mcp_server_urls = {"server-0": "http://localhost:3001"}
    adapter.mcp_server_url = "http://localhost:3001"

    @contextmanager
    def _fake_adapter(_config):
        yield adapter

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _fake_adapter)
    monkeypatch.setattr(tool_registry_cli, "validate_active_tool_mappings", lambda **_kwargs: [])

    result = CliRunner().invoke(
        tool_registry_cli.preflight,
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code == 0, result.output
    assert "preflight passed" in result.output.lower()


@pytest.mark.unit
def test_preflight_command_fails_when_issues_found(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _AdapterStub()
    adapter.authority_evaluator = SimpleNamespace(db_session=object())
    adapter._mcp_server_urls = {}
    adapter.mcp_server_url = None

    @contextmanager
    def _fake_adapter(_config):
        yield adapter

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _fake_adapter)
    monkeypatch.setattr(
        tool_registry_cli,
        "validate_active_tool_mappings",
        lambda **_kwargs: [
            {
                "tool_id": "tool.bad",
                "check": "mapping",
                "message": "Provider drift",
            }
        ],
    )

    result = CliRunner().invoke(
        tool_registry_cli.preflight,
        obj=SimpleNamespace(config=object()),
    )

    assert result.exit_code != 0
    assert "preflight failed" in result.output.lower()
    assert "tool.bad" in result.output
