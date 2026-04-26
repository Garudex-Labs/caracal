"""Integration parity checks for CLI and TUI mandate issuance from tool registry records."""

from __future__ import annotations

from datetime import datetime, timedelta
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from click.testing import CliRunner
from rich.console import Console

import caracal.cli.authority as authority_cli
import caracal.cli.deployment_cli as deployment_cli
import caracal.cli.tool_registry as tool_registry_cli
import caracal.flow.screens.mandate_flow as mandate_flow_module
import caracal.flow.screens.provider_manager as provider_manager_module
from caracal.flow.screens.mandate_flow import MandateFlow


@pytest.mark.integration
def test_cli_and_tui_issue_mandate_use_identical_tool_contract_scopes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tool_contract = {
        "tool_ids": ["tool.one", "tool.two"],
        "providers": ["endframe"],
        "resource_scope": [
            "provider:endframe:resource:deployments",
            "provider:endframe:resource:pipelines",
        ],
        "action_scope": ["provider:endframe:action:invoke"],
    }

    # --- CLI path ---------------------------------------------------------
    cli_issue_payload: dict[str, object] = {}

    class _CliMandateManager:
        def __init__(self):
            self.db_session = SimpleNamespace(commit=lambda: None)

        def issue_mandate(self, **kwargs):
            cli_issue_payload.update(kwargs)
            return SimpleNamespace(
                mandate_id=uuid4(),
                issuer_id=kwargs["issuer_id"],
                subject_id=kwargs["subject_id"],
                valid_from=datetime.utcnow(),
                valid_until=datetime.utcnow() + timedelta(hours=1),
                resource_scope=list(kwargs["resource_scope"]),
                action_scope=list(kwargs["action_scope"]),
                signature="sig",
                created_at=datetime.utcnow(),
                revoked=False,
                delegation_type="direct",
                network_distance=kwargs.get("network_distance") or 0,
            )

    cli_manager = _CliMandateManager()
    cli_db_manager = SimpleNamespace(close=lambda: None)

    monkeypatch.setattr(authority_cli, "get_workspace_from_ctx", lambda _ctx: "test-workspace")
    monkeypatch.setattr(authority_cli, "validate_provider_scopes", lambda **_kwargs: None)
    monkeypatch.setattr(
        authority_cli,
        "resolve_issue_scopes_from_tool_ids",
        lambda **_kwargs: tool_contract,
    )
    monkeypatch.setattr(
        authority_cli,
        "get_mandate_manager",
        lambda _config: (cli_manager, cli_db_manager),
    )

    runner = CliRunner()
    cli_result = runner.invoke(
        authority_cli.issue,
        [
            "--issuer-id",
            "11111111-1111-1111-1111-111111111111",
            "--subject-id",
            "22222222-2222-2222-2222-222222222222",
            "--tool-id",
            "tool.one",
            "--tool-id",
            "tool.two",
            "--validity-seconds",
            "3600",
        ],
        obj={"config": Mock()},
    )

    assert cli_result.exit_code == 0, cli_result.output

    # --- TUI path ---------------------------------------------------------
    tui_issue_payload: dict[str, object] = {}

    class _FakePrompt:
        def __init__(self):
            self._uuid_values = iter([
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
            ])
            self._select_values = iter([
                "all",
                "tool.one",
                "tool.two",
                "done",
            ])

        def uuid(self, _label, _items):
            return next(self._uuid_values)

        def select(self, _label, choices=None, default=None):
            del choices, default
            return next(self._select_values)

        def number(self, _label, default=None, min_value=None, max_value=None):
            del default, min_value, max_value
            return 3600

        def confirm(self, _label, default=False):
            del default
            return True

    principal_rows = [
        SimpleNamespace(principal_id=uuid4(), name="issuer"),
        SimpleNamespace(principal_id=uuid4(), name="subject"),
    ]
    registered_tool_rows = [
        SimpleNamespace(tool_id="tool.one", active=True, provider_name="endframe"),
        SimpleNamespace(tool_id="tool.two", active=True, provider_name="endframe"),
    ]
    policy_rows = [SimpleNamespace(allow_delegation=True, max_network_distance=2)]

    class _Query:
        def __init__(self, rows):
            self._rows = list(rows)

        def all(self):
            return list(self._rows)

        def filter_by(self, **kwargs):
            rows = [
                row for row in self._rows
                if all(getattr(row, key, None) == value for key, value in kwargs.items())
            ]
            return _Query(rows)

        def order_by(self, *_args, **_kwargs):
            return self

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self._rows[0] if self._rows else None

    class _Session:
        def query(self, model):
            if model.__name__ == "Principal":
                return _Query(principal_rows)
            if model.__name__ == "RegisteredTool":
                return _Query(registered_tool_rows)
            if model.__name__ == "AuthorityPolicy":
                return _Query(policy_rows)
            raise AssertionError(f"Unexpected model query: {model}")

    class _Scope:
        def __init__(self, session):
            self._session = session

        def __enter__(self):
            return self._session

        def __exit__(self, exc_type, exc, tb):
            del exc_type, exc, tb
            return False

    class _DbManager:
        def __init__(self):
            self._session = _Session()

        def session_scope(self):
            return _Scope(self._session)

        def close(self):
            return None

    class _TuiMandateManager:
        def __init__(self, db_session):
            self.db_session = db_session

        def issue_mandate(self, **kwargs):
            tui_issue_payload.update(kwargs)
            return SimpleNamespace(
                mandate_id=uuid4(),
                valid_until=datetime.utcnow() + timedelta(hours=1),
                network_distance=kwargs.get("network_distance") or 0,
            )

    monkeypatch.setattr("caracal.db.connection.get_db_manager", lambda: _DbManager())
    monkeypatch.setattr("caracal.core.mandate.MandateManager", _TuiMandateManager)
    monkeypatch.setattr(
        mandate_flow_module,
        "resolve_issue_scopes_from_tool_ids",
        lambda **_kwargs: tool_contract,
    )
    monkeypatch.setattr(mandate_flow_module, "validate_provider_scopes", lambda **_kwargs: None)
    monkeypatch.setattr(MandateFlow, "_resolve_active_workspace_name", staticmethod(lambda: "test-workspace"))

    flow = MandateFlow(console=Console(record=True))
    flow.prompt = _FakePrompt()
    flow.issue_mandate()

    assert cli_issue_payload["resource_scope"] == tui_issue_payload["resource_scope"]
    assert cli_issue_payload["action_scope"] == tui_issue_payload["action_scope"]
    assert cli_issue_payload["resource_scope"] == tool_contract["resource_scope"]
    assert cli_issue_payload["action_scope"] == tool_contract["action_scope"]


@pytest.mark.integration
def test_cli_and_tui_provider_creation_persist_identical_provider_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()

    cli_saved: dict[str, dict] = {}
    tui_saved: dict[str, dict] = {}

    monkeypatch.setattr(
        deployment_cli,
        "get_deployment_edition_adapter",
        lambda: SimpleNamespace(uses_gateway_execution=lambda: False),
    )
    monkeypatch.setattr(deployment_cli, "ConfigManager", lambda: SimpleNamespace())
    monkeypatch.setattr(
        deployment_cli,
        "_require_workspace",
        lambda _config_manager, workspace: workspace or "test-workspace",
    )
    monkeypatch.setattr(deployment_cli, "_load_workspace_providers", lambda _cm, _ws: {})
    monkeypatch.setattr(
        deployment_cli,
        "_save_workspace_providers",
        lambda _cm, _ws, providers: cli_saved.update(providers),
    )

    cli_result = runner.invoke(
        deployment_cli.provider_add,
        [
            "endframe",
            "--mode",
            "passthrough",
            "--service-type",
            "ai",
            "--provider-definition",
            "endframe",
            "--base-url",
            "https://api.endframe.dev",
            "--auth-scheme",
            "bearer",
            "--credential-ref",
            "caracal:test/providers/endframe/credential",
            "--workspace",
            "test-workspace",
        ],
    )
    assert cli_result.exit_code == 0, cli_result.output

    monkeypatch.setattr(
        provider_manager_module,
        "get_deployment_edition_adapter",
        lambda: SimpleNamespace(allows_local_provider_management=lambda: True),
    )
    monkeypatch.setattr(provider_manager_module, "ConfigManager", lambda: SimpleNamespace())
    monkeypatch.setattr(provider_manager_module, "_active_workspace", lambda _cm: "test-workspace")
    monkeypatch.setattr(provider_manager_module, "load_workspace_provider_registry", lambda _cm, _ws: {})
    monkeypatch.setattr(
        provider_manager_module,
        "save_workspace_provider_registry",
        lambda _cm, _ws, providers: tui_saved.update(providers),
    )
    monkeypatch.setattr(
        provider_manager_module,
        "sync_workspace_provider_registry_runtime",
        lambda **_kwargs: {"upserted": 0, "disabled": 0, "active": 0},
    )
    monkeypatch.setattr(
        provider_manager_module,
        "_prompt_identifier",
        lambda **_kwargs: "endframe",
    )
    monkeypatch.setattr(
        provider_manager_module,
        "_collect_connection_settings",
        lambda **_kwargs: (
            "bearer",
            "https://api.endframe.dev",
            "reuse-existing",
            None,
            "caracal:test/providers/endframe/credential",
            None,
        ),
    )
    monkeypatch.setattr(provider_manager_module, "_render_summary", lambda **_kwargs: None)
    monkeypatch.setattr(provider_manager_module.Confirm, "ask", lambda *_a, **_k: True)
    monkeypatch.setattr(provider_manager_module.Prompt, "ask", lambda *_a, **_k: "")

    class _TuiPrompt:
        def __init__(self, _console):
            self._select_values = iter(["passthrough"])
            self._text_values = iter(["ai"])

        def select(self, _label, _choices, default=None):
            del _label, _choices, default
            return next(self._select_values)

        def text(self, _label, default=None, validator=None):
            del _label, default, validator
            return next(self._text_values)

    monkeypatch.setattr(provider_manager_module, "FlowPrompt", _TuiPrompt)

    provider_manager_module._add_provider(Console(record=True), state=None)

    assert "endframe" in cli_saved
    assert "endframe" in tui_saved

    cli_entry = dict(cli_saved["endframe"])
    tui_entry = dict(tui_saved["endframe"])
    for transient in ("created_at", "updated_at"):
        cli_entry.pop(transient, None)
        tui_entry.pop(transient, None)

    assert cli_entry == tui_entry


@pytest.mark.integration
def test_cli_and_tui_tool_registration_call_identical_core_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()
    cli_calls: list[dict] = []
    tui_calls: list[dict] = []

    class _AdapterStub:
        def __init__(self, sink: list[dict]) -> None:
            self._sink = sink

        def register_tool(self, **kwargs):
            self._sink.append(dict(kwargs))
            return SimpleNamespace(tool_id=kwargs["tool_id"], active=kwargs["active"])

    @contextmanager
    def _cli_adapter(_config):
        yield _AdapterStub(cli_calls)

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _cli_adapter)
    monkeypatch.setattr(
        tool_registry_cli,
        "ConfigManager",
        lambda: SimpleNamespace(get_default_workspace_name=lambda: "test-workspace"),
    )
    monkeypatch.setattr(
        tool_registry_cli,
        "load_workspace_provider_registry",
        lambda _cm, _ws: {
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

    cli_result = runner.invoke(
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
    assert cli_result.exit_code == 0, cli_result.output

    @contextmanager
    def _tui_adapter():
        yield _AdapterStub(tui_calls)

    monkeypatch.setattr(provider_manager_module, "_tool_registry_adapter", _tui_adapter)
    monkeypatch.setattr(provider_manager_module, "ConfigManager", lambda: SimpleNamespace())
    monkeypatch.setattr(provider_manager_module, "_active_workspace", lambda _cm: "test-workspace")
    monkeypatch.setattr(
        provider_manager_module,
        "load_workspace_provider_registry",
        lambda _cm, _ws: {
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
    monkeypatch.setattr(provider_manager_module.Prompt, "ask", lambda *_a, **_k: "")

    class _ToolPrompt:
        def __init__(self, _console):
            self._select_values = iter(["endframe", "deployments", "invoke", "mcp_forward", "direct_api"])
            self._text_values = iter(
                [
                    "tool.echo",
                    "server-0",
                    "11111111-1111-1111-1111-111111111111",
                ]
            )

        def select(self, _label, _choices, default=None):
            del _label, _choices, default
            return next(self._select_values)

        def text(self, _label, default=None, validator=None):
            del _label, default, validator
            return next(self._text_values)

    monkeypatch.setattr(provider_manager_module, "FlowPrompt", _ToolPrompt)

    provider_manager_module._tool_registry_register(Console(record=True), state=None)

    assert len(cli_calls) == 1
    assert len(tui_calls) == 1
    assert cli_calls[0] == tui_calls[0]


@pytest.mark.integration
def test_cli_and_tui_tool_registration_local_logic_contract_parity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CliRunner()
    cli_calls: list[dict] = []
    tui_calls: list[dict] = []

    class _AdapterStub:
        def __init__(self, sink: list[dict]) -> None:
            self._sink = sink

        def register_tool(self, **kwargs):
            self._sink.append(dict(kwargs))
            return SimpleNamespace(tool_id=kwargs["tool_id"], active=kwargs["active"])

    @contextmanager
    def _cli_adapter(_config):
        yield _AdapterStub(cli_calls)

    monkeypatch.setattr(tool_registry_cli, "_tool_registry_adapter", _cli_adapter)
    monkeypatch.setattr(
        tool_registry_cli,
        "ConfigManager",
        lambda: SimpleNamespace(get_default_workspace_name=lambda: "test-workspace"),
    )
    monkeypatch.setattr(
        tool_registry_cli,
        "load_workspace_provider_registry",
        lambda _cm, _ws: {
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

    cli_result = runner.invoke(
        tool_registry_cli.register,
        [
            "--tool-id",
            "tool.echo.local.logic",
            "--provider-name",
            "endframe",
            "--resource-id",
            "deployments",
            "--action-id",
            "invoke",
            "--provider-definition-id",
            "endframe",
            "--execution-mode",
            "local",
            "--tool-type",
            "logic",
            "--handler-ref",
            "tests.handlers:run",
            "--actor-principal-id",
            "11111111-1111-1111-1111-111111111111",
        ],
        obj=SimpleNamespace(config=object()),
    )
    assert cli_result.exit_code == 0, cli_result.output

    @contextmanager
    def _tui_adapter():
        yield _AdapterStub(tui_calls)

    monkeypatch.setattr(provider_manager_module, "_tool_registry_adapter", _tui_adapter)
    monkeypatch.setattr(provider_manager_module, "ConfigManager", lambda: SimpleNamespace())
    monkeypatch.setattr(provider_manager_module, "_active_workspace", lambda _cm: "test-workspace")
    monkeypatch.setattr(
        provider_manager_module,
        "load_workspace_provider_registry",
        lambda _cm, _ws: {
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
    monkeypatch.setattr(provider_manager_module.Prompt, "ask", lambda *_a, **_k: "")

    class _ToolPrompt:
        def __init__(self, _console):
            self._select_values = iter(["endframe", "deployments", "invoke", "local", "logic"])
            self._text_values = iter(
                [
                    "tool.echo.local.logic",
                    "tests.handlers:run",
                    "11111111-1111-1111-1111-111111111111",
                ]
            )

        def select(self, _label, _choices, default=None):
            del _label, _choices, default
            return next(self._select_values)

        def text(self, _label, default=None, validator=None):
            del _label, default, validator
            return next(self._text_values)

    monkeypatch.setattr(provider_manager_module, "FlowPrompt", _ToolPrompt)

    provider_manager_module._tool_registry_register(Console(record=True), state=None)

    assert len(cli_calls) == 1
    assert len(tui_calls) == 1
    assert cli_calls[0] == tui_calls[0]
