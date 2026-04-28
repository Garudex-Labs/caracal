"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for MCP adapter service endpoint contracts.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


def _build_app():
    from caracal.core.authority import AuthorityEvaluator
    from caracal.mcp.adapter import MCPAdapter
    from caracal.mcp.service import MCPAdapterService, MCPServiceConfig

    class _Query:
        def __init__(self, rows):
            self._rows = list(rows)

        def filter_by(self, **kwargs):
            return _Query(
                [
                    row
                    for row in self._rows
                    if all(getattr(row, key, None) == value for key, value in kwargs.items())
                ]
            )

        def first(self):
            return self._rows[0] if self._rows else None

        def all(self):
            return list(self._rows)

    class _DbSession:
        def __init__(self):
            self.principal_rows: list[object] = []

        def query(self, model):
            if getattr(model, "__name__", "") == "Principal":
                return _Query(self.principal_rows)
            return _Query([])

        def execute(self, *_args, **_kwargs):
            class _ScalarResult:
                def all(self):
                    return [SimpleNamespace(resource_pattern="*", pattern_type="glob")]

            class _Result:
                def scalars(self):
                    return _ScalarResult()

            return _Result()

    db_session = _DbSession()
    evaluator = AuthorityEvaluator(db_session)
    adapter = MCPAdapter(
        authority_evaluator=evaluator,
        metering_collector=MagicMock(),
    )
    session_manager = MagicMock()
    service = MCPAdapterService(
        config=MCPServiceConfig(listen_address="0.0.0.0:8080"),
        mcp_adapter=adapter,
        authority_evaluator=evaluator,
        metering_collector=MagicMock(),
        session_manager=session_manager,
    )
    return service.app, session_manager, db_session


@pytest.mark.integration
class TestHealthEndpoint:
    def test_health_returns_200(self) -> None:
        app, _, _ = _build_app()
        resp = TestClient(app).get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"


@pytest.mark.integration
class TestToolCallAuth:
    def test_missing_authorization_returns_401_or_503(self) -> None:
        app, _, _ = _build_app()
        resp = TestClient(app, raise_server_exceptions=False).post(
            "/mcp/tool/call",
            json={"tool_id": "ops.read_incident", "tool_args": {}},
        )
        assert resp.status_code in {401, 503}

    def test_malformed_bearer_returns_401_or_503(self) -> None:
        app, _, _ = _build_app()
        resp = TestClient(app, raise_server_exceptions=False).post(
            "/mcp/tool/call",
            headers={"Authorization": "Bogus token"},
            json={"tool_id": "ops.read_incident", "tool_args": {}},
        )
        assert resp.status_code in {401, 503}


@pytest.mark.integration
class TestSpoofRejection:
    def test_caller_supplied_principal_id_in_metadata_rejected(self) -> None:
        app, sm, db_session = _build_app()
        principal_id = str(uuid4())
        db_session.principal_rows = [
            SimpleNamespace(principal_id=principal_id, lifecycle_status="active", capabilities=[])
        ]
        sm.validate_access_token = AsyncMock(
            return_value={"sub": principal_id, "typ": "access"}
        )
        resp = TestClient(app, raise_server_exceptions=False).post(
            "/mcp/tool/call",
            headers={"Authorization": "Bearer tok"},
            json={
                "tool_id": "ops.read_incident",
                "tool_args": {},
                "metadata": {"principal_id": str(uuid4())},
            },
        )
        assert resp.status_code == 400

    def test_caller_supplied_mandate_id_in_metadata_rejected(self) -> None:
        app, sm, db_session = _build_app()
        principal_id = str(uuid4())
        db_session.principal_rows = [
            SimpleNamespace(principal_id=principal_id, lifecycle_status="active", capabilities=[])
        ]
        sm.validate_access_token = AsyncMock(
            return_value={"sub": principal_id, "typ": "access"}
        )
        resp = TestClient(app, raise_server_exceptions=False).post(
            "/mcp/tool/call",
            headers={"Authorization": "Bearer tok"},
            json={
                "tool_id": "ops.read_incident",
                "tool_args": {},
                "metadata": {"mandate_id": str(uuid4())},
            },
        )
        assert resp.status_code == 400

    def test_caller_supplied_principal_id_in_tool_args_rejected(self) -> None:
        app, sm, db_session = _build_app()
        principal_id = str(uuid4())
        db_session.principal_rows = [
            SimpleNamespace(principal_id=principal_id, lifecycle_status="active", capabilities=[])
        ]
        sm.validate_access_token = AsyncMock(
            return_value={"sub": principal_id, "typ": "access"}
        )
        resp = TestClient(app, raise_server_exceptions=False).post(
            "/mcp/tool/call",
            headers={"Authorization": "Bearer tok"},
            json={
                "tool_id": "ops.read_incident",
                "tool_args": {"principal_id": str(uuid4())},
                "metadata": {},
            },
        )
        assert resp.status_code == 400
