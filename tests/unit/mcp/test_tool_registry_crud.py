"""Unit tests for MCP adapter persisted tool-registry CRUD operations."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError

from caracal.db.models import AuthorityLedgerEvent, GatewayProvider, RegisteredTool
from caracal.exceptions import CaracalError, MCPToolBindingError, MCPToolTypeMismatchError
from caracal.mcp.adapter import MCPAdapter


_ACTOR_PRINCIPAL_ID = "11111111-1111-1111-1111-111111111111"
_PROVIDER_NAME = "endframe"
_RESOURCE_SCOPE = "provider:endframe:resource:deployments"
_ACTION_SCOPE = "provider:endframe:action:invoke"
_ACTION_METHOD = "POST"
_ACTION_PATH_PREFIX = "/v1/deployments"


def _provider_definition_payload() -> dict:
    return {
        "definition_id": _PROVIDER_NAME,
        "resources": {
            "deployments": {
                "actions": {
                    "invoke": {
                        "description": "Invoke deployment execution",
                        "method": _ACTION_METHOD,
                        "path_prefix": _ACTION_PATH_PREFIX,
                    }
                }
            }
        },
    }


class _QueryStub:
    def __init__(self, rows: list[RegisteredTool]) -> None:
        self._rows = rows

    def filter_by(self, **kwargs):
        filtered = [
            row for row in self._rows
            if all(getattr(row, key) == value for key, value in kwargs.items())
        ]
        return _QueryStub(filtered)

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)


class _SessionStub:
    def __init__(self) -> None:
        self._rows_by_model: dict[type, list] = {}
        self.commits = 0
        self.rollbacks = 0

    def query(self, model):
        return _QueryStub(list(self._rows_by_model.get(model, [])))

    def add(self, row) -> None:
        self._rows_by_model.setdefault(type(row), []).append(row)

    def flush(self) -> None:
        rows = list(self._rows_by_model.get(RegisteredTool, []))
        active_keys = [
            (
                row.tool_id,
                str(getattr(row, "workspace_name", "") or "").strip() or "default",
            )
            for row in rows
            if bool(getattr(row, "active", False))
        ]
        if len(active_keys) != len(set(active_keys)):
            raise RuntimeError("duplicate tool_id")

        for row in rows:
            if row.created_at is None:
                row.created_at = datetime.utcnow()
            if row.updated_at is None:
                row.updated_at = row.created_at
            if row.active is None:
                row.active = True

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _PGIntegrityOrigin(Exception):
    def __init__(self, *, pgcode: str, constraint_name: str, message: str):
        super().__init__(message)
        self.pgcode = pgcode
        self.diag = SimpleNamespace(constraint_name=constraint_name)


class _IntegrityFailSessionStub(_SessionStub):
    def __init__(self, integrity_error: IntegrityError) -> None:
        super().__init__()
        self._integrity_error = integrity_error

    def flush(self) -> None:
        raise self._integrity_error


def _make_integrity_error(*, pgcode: str, constraint_name: str, message: str) -> IntegrityError:
    return IntegrityError(
        "insert into registered_tools ...",
        {},
        _PGIntegrityOrigin(
            pgcode=pgcode,
            constraint_name=constraint_name,
            message=message,
        ),
    )


def _add_provider_row(session: _SessionStub, *, provider_id: str = _PROVIDER_NAME) -> None:
    session.add(
        GatewayProvider(
            provider_id=provider_id,
            name=provider_id,
            base_url="https://api.example.com",
            auth_scheme="none",
            definition=_provider_definition_payload(),
            enabled=True,
        )
    )


@pytest.mark.unit
def test_register_and_list_registered_tools() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    created = adapter.register_tool(
        tool_id="tool.echo",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
    )

    assert created.tool_id == "tool.echo"
    assert created.active is True
    assert created.execution_mode == "mcp_forward"
    assert created.mcp_server_name is None

    listed_all = adapter.list_registered_tools(include_inactive=True)
    listed_active = adapter.list_registered_tools(include_inactive=False)

    assert [row.tool_id for row in listed_all] == ["tool.echo"]
    assert [row.tool_id for row in listed_active] == ["tool.echo"]
    events = session._rows_by_model.get(AuthorityLedgerEvent, [])
    assert [event.event_type for event in events] == ["tool_registered"]


@pytest.mark.unit
def test_register_tool_maps_tool_id_uniqueness_integrity_error() -> None:
    session = _IntegrityFailSessionStub(
        _make_integrity_error(
            pgcode="23505",
            constraint_name="uq_registered_tools_active_workspace_tool_id",
            message="duplicate key value violates unique constraint \"uq_registered_tools_active_workspace_tool_id\"",
        )
    )
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Tool already registered: tool.duplicate"):
        adapter.register_tool(
            tool_id="tool.duplicate",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            action_method=_ACTION_METHOD,
            action_path_prefix=_ACTION_PATH_PREFIX,
        )

    assert session.rollbacks == 1


@pytest.mark.unit
def test_register_tool_maps_binding_uniqueness_integrity_error() -> None:
    session = _IntegrityFailSessionStub(
        _make_integrity_error(
            pgcode="23505",
            constraint_name="uq_registered_tools_active_workspace_binding",
            message="duplicate key value violates unique constraint \"uq_registered_tools_active_workspace_binding\"",
        )
    )
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Active tool binding already exists"):
        adapter.register_tool(
            tool_id="tool.binding-conflict",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            action_method=_ACTION_METHOD,
            action_path_prefix=_ACTION_PATH_PREFIX,
        )

    assert session.rollbacks == 1


@pytest.mark.unit
def test_register_tool_maps_actor_principal_fk_integrity_error() -> None:
    session = _IntegrityFailSessionStub(
        _make_integrity_error(
            pgcode="23503",
            constraint_name="authority_ledger_events_principal_id_fkey",
            message="insert or update on table \"authority_ledger_events\" violates foreign key constraint \"authority_ledger_events_principal_id_fkey\"",
        )
    )
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Invalid actor_principal_id"):
        adapter.register_tool(
            tool_id="tool.actor-fk",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            action_method=_ACTION_METHOD,
            action_path_prefix=_ACTION_PATH_PREFIX,
        )

    assert session.rollbacks == 1


@pytest.mark.unit
def test_deactivate_and_reactivate_tool() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.deploy",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
    )
    deactivated = adapter.deactivate_tool(
        tool_id="tool.deploy",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
    )

    assert deactivated.active is False
    assert adapter.list_registered_tools(include_inactive=False) == []

    reactivated = adapter.reactivate_tool(
        tool_id="tool.deploy",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
    )

    assert reactivated.active is True
    assert [row.tool_id for row in adapter.list_registered_tools(include_inactive=False)] == [
        "tool.deploy"
    ]
    events = session._rows_by_model.get(AuthorityLedgerEvent, [])
    assert [event.event_type for event in events] == [
        "tool_registered",
        "tool_deactivated",
        "tool_reactivated",
    ]


@pytest.mark.unit
def test_workspace_scoped_deactivate_only_affects_selected_workspace() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.shared",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
        workspace_name="alpha",
    )
    adapter.register_tool(
        tool_id="tool.shared",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
        workspace_name="beta",
    )

    deactivated = adapter.deactivate_tool(
        tool_id="tool.shared",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        workspace_name="alpha",
    )
    assert deactivated.active is False

    alpha_row = adapter.get_registered_tool(
        tool_id="tool.shared",
        workspace_name="alpha",
        require_active=False,
    )
    beta_row = adapter.get_registered_tool(
        tool_id="tool.shared",
        workspace_name="beta",
        require_active=False,
    )
    assert alpha_row is not None
    assert beta_row is not None
    assert alpha_row.active is False
    assert beta_row.active is True


@pytest.mark.unit
def test_workspace_scoped_list_filters_rows() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.alpha",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
        workspace_name="alpha",
    )
    adapter.register_tool(
        tool_id="tool.beta",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
        workspace_name="beta",
    )

    alpha_rows = adapter.list_registered_tools(
        include_inactive=True,
        workspace_name="alpha",
    )
    beta_rows = adapter.list_registered_tools(
        include_inactive=True,
        workspace_name="beta",
    )

    assert [row.tool_id for row in alpha_rows] == ["tool.alpha"]
    assert [row.tool_id for row in beta_rows] == ["tool.beta"]


@pytest.mark.unit
def test_get_registered_tool_falls_back_to_default_registration_for_scoped_lookup() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.shared-default",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        action_method=_ACTION_METHOD,
        action_path_prefix=_ACTION_PATH_PREFIX,
        workspace_name=None,
    )

    row = adapter.get_registered_tool(
        tool_id="tool.shared-default",
        workspace_name="workspace-from-sdk-scope",
        require_active=True,
    )

    assert row is not None
    assert row.tool_id == "tool.shared-default"
    assert (getattr(row, "workspace_name", None) or "") in {"", "default"}


@pytest.mark.unit
def test_deactivate_unknown_tool_raises() -> None:
    session = _SessionStub()
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Unknown tool_id"):
        adapter.deactivate_tool(
            tool_id="missing.tool",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
        )


@pytest.mark.unit
def test_register_tool_rejects_missing_provider() -> None:
    session = _SessionStub()
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="is not registered in workspace provider registry"):
        adapter.register_tool(
            tool_id="tool.missing-provider",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name="missing",
            resource_scope="provider:missing:resource:deployments",
            action_scope="provider:missing:action:invoke",
            provider_definition_id="missing",
        )


@pytest.mark.unit
def test_register_tool_rejects_invalid_resource_scope() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Resource scope 'provider:endframe:resource:unknown'"):
        adapter.register_tool(
            tool_id="tool.bad-resource",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope="provider:endframe:resource:unknown",
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
        )


@pytest.mark.unit
def test_register_tool_rejects_invalid_action_scope() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Action scope 'provider:endframe:action:destroy'"):
        adapter.register_tool(
            tool_id="tool.bad-action",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope="provider:endframe:action:destroy",
            provider_definition_id=_PROVIDER_NAME,
        )


@pytest.mark.unit
def test_register_tool_rejects_action_contract_mismatch() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(CaracalError, match="Action method mismatch"):
        adapter.register_tool(
            tool_id="tool.bad-method",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            action_method="GET",
            action_path_prefix=_ACTION_PATH_PREFIX,
        )

    with pytest.raises(CaracalError, match="Action path mismatch"):
        adapter.register_tool(
            tool_id="tool.bad-path",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            action_method=_ACTION_METHOD,
            action_path_prefix="/v2/deployments",
        )


@pytest.mark.unit
def test_register_tool_rejects_logic_tool_without_handler_ref() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(MCPToolBindingError, match="requires handler_ref"):
        adapter.register_tool(
            tool_id="tool.logic-missing-handler",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            execution_mode="local",
            tool_type="logic",
        )


@pytest.mark.unit
def test_register_tool_allows_forward_logic_without_handler_ref() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
        mcp_server_url="http://localhost:3001",
    )

    created = adapter.register_tool(
        tool_id="tool.logic-forward",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
        execution_mode="mcp_forward",
        tool_type="logic",
    )

    assert created.tool_id == "tool.logic-forward"
    assert created.execution_mode == "mcp_forward"
    assert created.tool_type == "logic"
    assert created.handler_ref is None


@pytest.mark.unit
def test_register_tool_rejects_direct_api_with_handler_ref() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(MCPToolTypeMismatchError, match="direct_api"):
        adapter.register_tool(
            tool_id="tool.direct-invalid-handler",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            tool_type="direct_api",
            handler_ref="custom.tools:execute",
        )


@pytest.mark.unit
def test_register_tool_rejects_direct_api_local_execution() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    with pytest.raises(MCPToolTypeMismatchError, match="must use mcp_forward"):
        adapter.register_tool(
            tool_id="tool.direct-local",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            execution_mode="local",
            tool_type="direct_api",
        )


@pytest.mark.unit
def test_register_tool_rejects_unknown_mcp_server_name_for_forward_mode() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
        mcp_server_url="http://localhost:3001",
        mcp_server_urls={"server-0": "http://localhost:3001"},
    )

    with pytest.raises(CaracalError, match="Unknown mcp_server_name"):
        adapter.register_tool(
            tool_id="tool.unknown-server",
            actor_principal_id=_ACTOR_PRINCIPAL_ID,
            provider_name=_PROVIDER_NAME,
            resource_scope=_RESOURCE_SCOPE,
            action_scope=_ACTION_SCOPE,
            provider_definition_id=_PROVIDER_NAME,
            execution_mode="mcp_forward",
            mcp_server_name="does-not-exist",
        )


@pytest.mark.unit
def test_deactivate_tool_clears_local_binding_cache() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.binding-cache",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
    )
    adapter._decorator_bindings["tool.binding-cache"] = lambda **_kwargs: {"ok": True}

    adapter.deactivate_tool(
        tool_id="tool.binding-cache",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
    )

    assert "tool.binding-cache" not in adapter._decorator_bindings


@pytest.mark.unit
def test_reactivate_tool_clears_local_binding_cache() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    adapter.register_tool(
        tool_id="tool.binding-cache-reactivate",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
        provider_name=_PROVIDER_NAME,
        resource_scope=_RESOURCE_SCOPE,
        action_scope=_ACTION_SCOPE,
        provider_definition_id=_PROVIDER_NAME,
    )
    adapter.deactivate_tool(
        tool_id="tool.binding-cache-reactivate",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
    )

    adapter._decorator_bindings["tool.binding-cache-reactivate"] = lambda **_kwargs: {"ok": True}
    adapter.reactivate_tool(
        tool_id="tool.binding-cache-reactivate",
        actor_principal_id=_ACTOR_PRINCIPAL_ID,
    )

    assert "tool.binding-cache-reactivate" not in adapter._decorator_bindings


@pytest.mark.unit
@pytest.mark.asyncio
async def test_execute_local_tool_rejects_handler_ref_mismatch() -> None:
    session = _SessionStub()
    _add_provider_row(session)
    authority_evaluator = SimpleNamespace(db_session=session)
    adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=Mock(),
    )

    async def _other_impl(**_kwargs):
        return {"ok": True}

    adapter._decorator_bindings["tool.handler-mismatch"] = _other_impl

    with pytest.raises(CaracalError, match="Local handler mismatch"):
        await adapter._execute_local_tool(
            tool_id="tool.handler-mismatch",
            principal_id="agent-123",
            mandate_id=uuid4(),
            tool_args={"payload": "ok"},
            handler_ref="custom.logic:execute",
        )
