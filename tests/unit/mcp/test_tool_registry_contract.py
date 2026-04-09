"""Unit tests for shared tool-registry contract helpers."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from caracal.exceptions import CaracalError
from caracal.mcp.tool_registry_contract import (
    deactivate_invalid_provider_tools,
    list_tool_bindings_by_provider,
    resolve_issue_scopes_from_tool_ids,
    validate_active_tool_mappings,
)


@pytest.mark.unit
@patch("caracal.mcp.tool_registry_contract.MCPAdapter")
@patch("caracal.mcp.tool_registry_contract.AuthorityEvaluator")
def test_resolve_issue_scopes_from_tool_ids_derives_canonical_scopes(
    _mock_authority_evaluator,
    mock_adapter,
) -> None:
    adapter_instance = mock_adapter.return_value
    adapter_instance._resolve_active_tool_mapping.side_effect = [
        {
            "tool_id": "tool.one",
            "provider_name": "endframe",
            "resource_scope": "provider:endframe:resource:deployments",
            "action_scope": "provider:endframe:action:invoke",
        },
        {
            "tool_id": "tool.two",
            "provider_name": "endframe",
            "resource_scope": "provider:endframe:resource:pipelines",
            "action_scope": "provider:endframe:action:invoke",
        },
    ]

    result = resolve_issue_scopes_from_tool_ids(
        db_session=Mock(),
        tool_ids=["tool.one", "tool.two"],
    )

    assert result == {
        "tool_ids": ["tool.one", "tool.two"],
        "providers": ["endframe"],
        "resource_scope": [
            "provider:endframe:resource:deployments",
            "provider:endframe:resource:pipelines",
        ],
        "action_scope": ["provider:endframe:action:invoke"],
    }


@pytest.mark.unit
@patch("caracal.mcp.tool_registry_contract.MCPAdapter")
@patch("caracal.mcp.tool_registry_contract.AuthorityEvaluator")
def test_resolve_issue_scopes_from_tool_ids_enforces_provider_filter(
    _mock_authority_evaluator,
    mock_adapter,
) -> None:
    adapter_instance = mock_adapter.return_value
    adapter_instance._resolve_active_tool_mapping.return_value = {
        "tool_id": "tool.one",
        "provider_name": "endframe",
        "resource_scope": "provider:endframe:resource:deployments",
        "action_scope": "provider:endframe:action:invoke",
    }

    with pytest.raises(CaracalError, match="outside selected provider filter"):
        resolve_issue_scopes_from_tool_ids(
            db_session=Mock(),
            tool_ids=["tool.one"],
            providers=["anthropic"],
        )


@pytest.mark.unit
def test_list_tool_bindings_by_provider_returns_active_bindings_only() -> None:
    class _Query:
        def __init__(self, rows):
            self._rows = list(rows)

        def filter_by(self, **kwargs):
            rows = [
                row for row in self._rows
                if all(getattr(row, key, None) == value for key, value in kwargs.items())
            ]
            return _Query(rows)

        def order_by(self, *_args, **_kwargs):
            return self

        def all(self):
            return list(self._rows)

    class _Session:
        def __init__(self, rows):
            self._rows = rows

        def query(self, _model):
            return _Query(self._rows)

    rows = [
        SimpleNamespace(tool_id="tool.a", provider_name="endframe", active=True),
        SimpleNamespace(tool_id="tool.b", provider_name="endframe", active=True),
        SimpleNamespace(tool_id="tool.c", provider_name="openai", active=False),
    ]

    result = list_tool_bindings_by_provider(db_session=_Session(rows), include_inactive=False)

    assert result == {"endframe": ["tool.a", "tool.b"]}


@pytest.mark.unit
@patch("caracal.mcp.tool_registry_contract.MCPAdapter")
@patch("caracal.mcp.tool_registry_contract.AuthorityEvaluator")
def test_validate_active_tool_mappings_reports_mapping_and_forward_target_drift(
    _mock_authority_evaluator,
    mock_adapter,
) -> None:
    class _Query:
        def __init__(self, rows):
            self._rows = list(rows)

        def filter_by(self, **kwargs):
            rows = [
                row for row in self._rows
                if all(getattr(row, key, None) == value for key, value in kwargs.items())
            ]
            return _Query(rows)

        def order_by(self, *_args, **_kwargs):
            return self

        def all(self):
            return list(self._rows)

    class _Session:
        def __init__(self, rows):
            self._rows = rows

        def query(self, _model):
            return _Query(self._rows)

    rows = [
        SimpleNamespace(tool_id="tool.bad-mapping", active=True),
        SimpleNamespace(tool_id="tool.bad-forward", active=True),
    ]

    adapter_instance = mock_adapter.return_value
    adapter_instance._resolve_active_tool_mapping.side_effect = [
        CaracalError("Mapped provider 'endframe' for tool 'tool.bad-mapping' was removed"),
        {
            "tool_id": "tool.bad-forward",
            "provider_name": "endframe",
            "resource_scope": "provider:endframe:resource:deployments",
            "action_scope": "provider:endframe:action:invoke",
            "execution_mode": "mcp_forward",
            "mcp_server_name": "missing-server",
        },
    ]

    issues = validate_active_tool_mappings(
        db_session=_Session(rows),
        named_server_urls={"server-0": "http://localhost:3001"},
        has_default_forward_target=True,
    )

    assert len(issues) == 2
    assert issues[0]["tool_id"] == "tool.bad-mapping"
    assert issues[0]["check"] == "mapping"
    assert "removed" in issues[0]["message"]
    assert issues[1]["tool_id"] == "tool.bad-forward"
    assert issues[1]["check"] == "forward_target"
    assert "unknown MCP server" in issues[1]["message"]


@pytest.mark.unit
@patch("caracal.mcp.tool_registry_contract.MCPAdapter")
@patch("caracal.mcp.tool_registry_contract.AuthorityEvaluator")
def test_deactivate_invalid_provider_tools_marks_only_drifted_tools_inactive(
    _mock_authority_evaluator,
    mock_adapter,
) -> None:
    class _Query:
        def __init__(self, rows):
            self._rows = list(rows)

        def filter_by(self, **kwargs):
            rows = [
                row for row in self._rows
                if all(getattr(row, key, None) == value for key, value in kwargs.items())
            ]
            return _Query(rows)

        def order_by(self, *_args, **_kwargs):
            return self

        def all(self):
            return list(self._rows)

    class _Session:
        def __init__(self, rows):
            self._rows = rows
            self.flushed = False

        def query(self, _model):
            return _Query(self._rows)

        def flush(self):
            self.flushed = True

    row_valid = SimpleNamespace(
        tool_id="tool.valid",
        provider_name="endframe",
        resource_scope="provider:endframe:resource:deployments",
        action_scope="provider:endframe:action:invoke",
        provider_definition_id="endframe",
        active=True,
        updated_at=None,
    )
    row_drifted = SimpleNamespace(
        tool_id="tool.drifted",
        provider_name="endframe",
        resource_scope="provider:endframe:resource:removed",
        action_scope="provider:endframe:action:invoke",
        provider_definition_id="endframe",
        active=True,
        updated_at=None,
    )
    session = _Session([row_valid, row_drifted])

    adapter_instance = mock_adapter.return_value
    adapter_instance._validate_tool_mapping.side_effect = [
        None,
        CaracalError("Resource scope drift detected"),
    ]

    impacted = deactivate_invalid_provider_tools(
        db_session=session,
        provider_name="endframe",
    )

    assert row_valid.active is True
    assert row_drifted.active is False
    assert row_drifted.updated_at is not None
    assert session.flushed is True
    assert impacted == [
        {
            "tool_id": "tool.drifted",
            "reason": "Resource scope drift detected",
        }
    ]
