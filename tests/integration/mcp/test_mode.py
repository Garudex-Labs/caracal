"""Integration test for SDK tool-call parity across local and forward execution modes."""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest

from caracal.core.metering import MeteringEvent
from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.service import MCPAdapterService, MCPServerConfig, MCPServiceConfig

from caracal_sdk.adapters.http import HttpAdapter
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry


class _Query:
    def __init__(self, rows):
        self._rows = list(rows)

    def filter_by(self, **kwargs):
        rows = [
            row for row in self._rows
            if all(getattr(row, key, None) == value for key, value in kwargs.items())
        ]
        return _Query(rows)

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)

    def order_by(self, *_args, **_kwargs):
        return self


class _SessionStub:
    def __init__(self, tool_rows: list[Any], provider_rows: list[Any]):
        self._tool_rows = tool_rows
        self._provider_rows = provider_rows

    def query(self, model):
        model_name = getattr(model, "__name__", str(model))
        if model_name == "RegisteredTool":
            return _Query(self._tool_rows)
        if model_name == "GatewayProvider":
            return _Query(self._provider_rows)
        raise AssertionError(f"Unsupported model query: {model_name}")


class _AuthorityEvaluatorStub:
    def __init__(self, db_session, caller_principal_id: str):
        self.db_session = db_session
        self._caller_principal_id = caller_principal_id
        self.validation_records: list[dict[str, Any]] = []
        self._mandate_id = uuid4()

    def resolve_mandate_for_principal(self, **_kwargs):
        return SimpleNamespace(
            mandate_id=self._mandate_id,
            subject_id=self._caller_principal_id,
            revoked=False,
            valid_until=datetime.utcnow() + timedelta(hours=1),
        )

    def _get_mandate_with_cache(self, mandate_id: UUID):
        if mandate_id != self._mandate_id:
            return None
        return SimpleNamespace(
            subject_id=self._caller_principal_id,
            revoked=False,
            valid_until=datetime.utcnow() + timedelta(hours=1),
        )

    def validate_mandate(self, *, mandate, requested_action, requested_resource, caller_principal_id, **_kwargs):
        self.validation_records.append(
            {
                "subject_id": str(getattr(mandate, "subject_id", "")),
                "caller_principal_id": str(caller_principal_id),
                "requested_action": str(requested_action),
                "requested_resource": str(requested_resource),
            }
        )
        return SimpleNamespace(allowed=True, reason="Authority granted")


class _MeteringCollectorStub:
    def __init__(self):
        self.events: list[MeteringEvent] = []

    def collect_event(self, event: MeteringEvent) -> None:
        self.events.append(event)


class _DbConnectionManagerStub:
    def health_check(self) -> bool:
        return True


class _SessionManagerStub:
    def __init__(self, caller_principal_id: str):
        self._caller_principal_id = caller_principal_id

    async def validate_access_token(self, _token: str):
        return {"sub": self._caller_principal_id}


def _provider_definition_payload() -> dict[str, Any]:
    return {
        "definition_id": "endframe",
        "service_type": "ai",
        "display_name": "endframe",
        "auth_scheme": "none",
        "default_base_url": "https://api.endframe.dev",
        "resources": {
            "deployments": {
                "description": "Deployments",
                "actions": {
                    "invoke": {
                        "description": "Invoke deployment",
                        "method": "POST",
                        "path_prefix": "/v1/deployments",
                    }
                },
            }
        },
        "metadata": {},
    }


def _build_service_app(
    *,
    execution_mode: str,
    tool_type: str | None = None,
    handler_ref: str | None = None,
):
    caller_principal_id = "11111111-1111-1111-1111-111111111111"
    tool_id = "tool.echo"
    normalized_tool_type = str(
        tool_type or ("logic" if execution_mode == "local" else "direct_api")
    ).strip().lower()
    normalized_handler_ref = str(handler_ref or "").strip() or None
    if execution_mode == "local" and normalized_tool_type == "logic" and not normalized_handler_ref:
        normalized_handler_ref = f"{__name__}:_local_tool"

    tool_row = SimpleNamespace(
        tool_id=tool_id,
        active=True,
        provider_name="endframe",
        resource_scope="provider:endframe:resource:deployments",
        action_scope="provider:endframe:action:invoke",
        provider_definition_id="endframe",
        tool_type=normalized_tool_type,
        handler_ref=normalized_handler_ref,
        execution_mode=execution_mode,
        mcp_server_name="server-0" if execution_mode == "mcp_forward" else None,
    )
    provider_row = SimpleNamespace(
        provider_id="endframe",
        enabled=True,
        definition=_provider_definition_payload(),
        provider_definition="endframe",
        service_type="ai",
        name="endframe",
        auth_scheme="none",
        base_url="https://api.endframe.dev",
        credential_ref=None,
    )

    db_session = _SessionStub(tool_rows=[tool_row], provider_rows=[provider_row])
    authority_evaluator = _AuthorityEvaluatorStub(db_session, caller_principal_id)
    metering_collector = _MeteringCollectorStub()
    mcp_adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=metering_collector,
        mcp_server_url="http://upstream.test",
        mcp_server_urls={"server-0": "http://upstream.test"},
    )

    if execution_mode == "local" and normalized_handler_ref:
        @mcp_adapter.as_decorator(tool_id=tool_id)
        async def _local_tool(principal_id: str, **tool_args):
            return {
                "principal_id": principal_id,
                "tool_args": tool_args,
                "mode": "local",
            }

        del _local_tool
    elif execution_mode == "mcp_forward":
        async def _mock_forward(*_args, **_kwargs):
            return {"mode": "forward", "ok": True}

        mcp_adapter._forward_to_mcp_server = _mock_forward

    service = MCPAdapterService(
        config=MCPServiceConfig(
            listen_address="127.0.0.1:0",
            mcp_servers=[MCPServerConfig(name="server-0", url="http://upstream.test")],
        ),
        mcp_adapter=mcp_adapter,
        authority_evaluator=authority_evaluator,
        metering_collector=metering_collector,
        db_connection_manager=_DbConnectionManagerStub(),
        session_manager=_SessionManagerStub(caller_principal_id),
    )

    return {
        "app": service.app,
        "tool_id": tool_id,
        "tool_type": normalized_tool_type,
        "authority_evaluator": authority_evaluator,
        "metering_collector": metering_collector,
    }


def _install_routed_async_client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    app_by_host: dict[str, Any],
) -> None:
    real_async_client = httpx.AsyncClient

    class _RoutedAsyncClient:
        def __init__(self, *args, **kwargs):
            del args
            base_url = str(kwargs.pop("base_url", "http://local.test")).rstrip("/")
            host = base_url.replace("http://", "").replace("https://", "").split("/", 1)[0]
            app = app_by_host.get(host)
            if app is None:
                raise AssertionError(f"Unexpected host for routed async client: {host}")

            headers = kwargs.pop("headers", None)
            timeout = kwargs.pop("timeout", None)
            follow_redirects = kwargs.pop("follow_redirects", False)
            self._inner = real_async_client(
                base_url=base_url,
                headers=headers,
                timeout=timeout,
                follow_redirects=follow_redirects,
                transport=httpx.ASGITransport(app=app),
            )

        async def request(self, *args, **kwargs):
            return await self._inner.request(*args, **kwargs)

        async def post(self, *args, **kwargs):
            return await self._inner.post(*args, **kwargs)

        async def aclose(self):
            await self._inner.aclose()

        @property
        def is_closed(self) -> bool:
            return self._inner.is_closed

    monkeypatch.setattr(httpx, "AsyncClient", _RoutedAsyncClient)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_sdk_tool_call_local_and_forward_modes_preserve_authorization_and_ledger_outcomes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    local_fixture = _build_service_app(execution_mode="local")
    forward_fixture = _build_service_app(execution_mode="mcp_forward")

    app_by_host = {
        "local.test": local_fixture["app"],
        "forward.test": forward_fixture["app"],
    }
    _install_routed_async_client(monkeypatch, app_by_host=app_by_host)

    local_scope = ScopeContext(
        adapter=HttpAdapter(base_url="http://local.test", api_key="sdk-token"),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )
    forward_scope = ScopeContext(
        adapter=HttpAdapter(base_url="http://forward.test", api_key="sdk-token"),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    local_response = await local_scope.tools.call(
        tool_id=local_fixture["tool_id"],
        tool_args={"payload": "ok"},
        metadata={"trace_id": "integration"},
    )
    forward_response = await forward_scope.tools.call(
        tool_id=forward_fixture["tool_id"],
        tool_args={"payload": "ok"},
        metadata={"trace_id": "integration"},
    )

    assert local_response["success"] is True
    assert forward_response["success"] is True
    assert local_response["metadata"]["execution_mode"] == "local"
    assert forward_response["metadata"]["execution_mode"] == "mcp_forward"

    local_auth_record = local_fixture["authority_evaluator"].validation_records
    forward_auth_record = forward_fixture["authority_evaluator"].validation_records
    assert len(local_auth_record) == 1
    assert len(forward_auth_record) == 1
    assert local_auth_record[0] == forward_auth_record[0]

    local_events = local_fixture["metering_collector"].events
    forward_events = forward_fixture["metering_collector"].events
    assert len(local_events) == 1
    assert len(forward_events) == 1
    assert local_events[0].principal_id == forward_events[0].principal_id
    assert local_events[0].resource_type == forward_events[0].resource_type
    assert local_events[0].metadata["tool_name"] == forward_events[0].metadata["tool_name"]
    assert local_events[0].metadata["mcp_context"]["token_subject"] == forward_events[0].metadata["mcp_context"]["token_subject"]

    local_scope._adapter.close()
    forward_scope._adapter.close()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_sdk_tool_call_forward_logic_mode_preserves_authorization_and_ledger_outcomes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _build_service_app(execution_mode="mcp_forward", tool_type="logic")
    _install_routed_async_client(monkeypatch, app_by_host={"forward-logic.test": fixture["app"]})

    scope = ScopeContext(
        adapter=HttpAdapter(base_url="http://forward-logic.test", api_key="sdk-token"),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    response = await scope.tools.call(
        tool_id=fixture["tool_id"],
        tool_args={"payload": "ok"},
        metadata={"trace_id": "integration-forward-logic"},
    )

    assert response["success"] is True
    assert response["metadata"]["execution_mode"] == "mcp_forward"
    assert response["metadata"]["tool_type"] == "logic"

    auth_records = fixture["authority_evaluator"].validation_records
    events = fixture["metering_collector"].events
    assert len(auth_records) == 1
    assert len(events) == 1
    assert events[0].metadata["tool_type"] == "logic"

    scope._adapter.close()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_sdk_tool_call_local_direct_api_contract_violation_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _build_service_app(execution_mode="local", tool_type="direct_api", handler_ref=None)
    _install_routed_async_client(monkeypatch, app_by_host={"local-direct-api.test": fixture["app"]})

    scope = ScopeContext(
        adapter=HttpAdapter(base_url="http://local-direct-api.test", api_key="sdk-token"),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    response = await scope.tools.call(
        tool_id=fixture["tool_id"],
        tool_args={"payload": "ok"},
        metadata={"trace_id": "integration-local-direct-api"},
    )

    assert response["success"] is False
    assert "direct_api" in str(response.get("error") or "")
    assert "mcp_forward" in str(response.get("error") or "")

    scope._adapter.close()