"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Transport Adapters.
"""

import pytest

from caracal.sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal.sdk.adapters.http import HttpAdapter
from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.adapters.websocket import WebSocketAdapter


class TestMockAdapter:
    def test_returns_mocked_response(self):
        responses = {
            ("GET", "/agents"): SDKResponse(
                status_code=200,
                headers={"Content-Type": "application/json"},
                body=[{"id": "a1", "name": "agent-1"}],
                elapsed_ms=1.0,
            ),
        }
        adapter = MockAdapter(responses=responses)
        assert adapter.is_connected is True

    @pytest.mark.asyncio
    async def test_send_returns_matched_response(self):
        expected = SDKResponse(status_code=200, body={"ok": True}, elapsed_ms=0.5)
        adapter = MockAdapter(responses={("POST", "/mandates"): expected})

        req = SDKRequest(method="POST", path="/mandates", headers={}, body={"agent_id": "a1"})
        result = await adapter.send(req)
        assert result.status_code == 200
        assert result.body == {"ok": True}

    @pytest.mark.asyncio
    async def test_send_returns_404_for_unmocked(self):
        adapter = MockAdapter()
        req = SDKRequest(method="GET", path="/unknown", headers={})
        result = await adapter.send(req)
        assert result.status_code == 404
        assert result.body == {"error": "not mocked"}

    @pytest.mark.asyncio
    async def test_tracks_sent_requests(self):
        adapter = MockAdapter()
        req = SDKRequest(method="DELETE", path="/agents/123", headers={"X-Test": "1"})
        await adapter.send(req)
        assert len(adapter.sent_requests) == 1
        assert adapter.sent_requests[0].path == "/agents/123"

    def test_close_clears_state(self):
        adapter = MockAdapter(responses={("GET", "/x"): SDKResponse(status_code=200)})
        adapter.close()
        assert adapter.is_connected is True  # mock is always "connected"


class TestHttpAdapter:
    def test_initialization(self):
        adapter = HttpAdapter(base_url="http://localhost:8000", api_key="sk_test")
        assert adapter.is_connected is True

    def test_initialization_strips_trailing_slash(self):
        adapter = HttpAdapter(base_url="http://localhost:8000///")
        assert adapter._base_url == "http://localhost:8000"

    def test_close(self):
        adapter = HttpAdapter(base_url="http://localhost:8000")
        adapter.close()
        assert adapter.is_connected is False


class TestWebSocketAdapter:
    def test_not_connected(self):
        adapter = WebSocketAdapter(url="wss://test:443")
        assert adapter.is_connected is False

    @pytest.mark.asyncio
    async def test_send_raises(self):
        adapter = WebSocketAdapter(url="wss://test:443")
        with pytest.raises(NotImplementedError, match="v0.4"):
            await adapter.send(SDKRequest(method="GET", path="/", headers={}))
