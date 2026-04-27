"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for gateway client dataclasses and utility functions.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from caracal.deployment.gateway_client import (
    GatewayHealthCheck,
    JWTToken,
    ProviderInfo,
    ProviderRequest,
    ProviderResponse,
    QueuedRequest,
    RequestPriority,
    _gateway_provider_request_headers,
)


@pytest.mark.unit
class TestJWTToken:
    def test_not_expired_when_well_before_expiry(self) -> None:
        token = JWTToken(
            token="abc",
            expires_at=datetime.now() + timedelta(hours=1),
        )
        assert not token.is_expired()

    def test_expired_when_past_expiry(self) -> None:
        token = JWTToken(
            token="abc",
            expires_at=datetime.now() - timedelta(minutes=1),
        )
        assert token.is_expired()

    def test_expired_within_buffer(self) -> None:
        token = JWTToken(
            token="abc",
            expires_at=datetime.now() + timedelta(seconds=30),
        )
        assert token.is_expired(buffer_seconds=60)

    def test_not_expired_when_buffer_has_room(self) -> None:
        token = JWTToken(
            token="abc",
            expires_at=datetime.now() + timedelta(minutes=5),
        )
        assert not token.is_expired(buffer_seconds=60)

    def test_zero_buffer(self) -> None:
        token = JWTToken(
            token="abc",
            expires_at=datetime.now() + timedelta(seconds=1),
        )
        assert not token.is_expired(buffer_seconds=0)

    def test_with_refresh_token(self) -> None:
        token = JWTToken(
            token="main",
            expires_at=datetime.now() + timedelta(hours=1),
            refresh_token="refresh",
        )
        assert token.refresh_token == "refresh"
        assert not token.is_expired()

    def test_refresh_token_defaults_none(self) -> None:
        token = JWTToken(token="t", expires_at=datetime.now() + timedelta(hours=1))
        assert token.refresh_token is None


@pytest.mark.unit
class TestQueuedRequest:
    def _make_request(self) -> ProviderRequest:
        return ProviderRequest(provider="p", method="GET", endpoint="/endpoint")

    def test_not_expired_when_within_ttl(self) -> None:
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.NORMAL,
            queued_at=datetime.now(),
            ttl_seconds=3600,
        )
        assert not req.is_expired()

    def test_expired_when_past_ttl(self) -> None:
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.LOW,
            queued_at=datetime.now() - timedelta(seconds=100),
            ttl_seconds=50,
        )
        assert req.is_expired()

    def test_exactly_at_ttl_boundary(self) -> None:
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.HIGH,
            queued_at=datetime.now() - timedelta(seconds=10),
            ttl_seconds=5,
        )
        assert req.is_expired()

    def test_retry_count_defaults_zero(self) -> None:
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.CRITICAL,
            queued_at=datetime.now(),
            ttl_seconds=60,
        )
        assert req.retry_count == 0


@pytest.mark.unit
class TestProviderInfo:
    def test_status_healthy_when_available(self) -> None:
        info = ProviderInfo(name="p", provider_type="llm", available=True)
        assert info.status == "healthy"

    def test_status_unavailable_when_not_available(self) -> None:
        info = ProviderInfo(name="p", provider_type="llm", available=False)
        assert info.status == "unavailable"

    def test_service_type_aliases_provider_type(self) -> None:
        info = ProviderInfo(name="p", provider_type="vector_db", available=True)
        assert info.service_type == "vector_db"

    def test_defaults(self) -> None:
        info = ProviderInfo(name="n", provider_type="t", available=True)
        assert info.quota_remaining is None
        assert info.auth_scheme is None
        assert info.version is None
        assert info.tags == []
        assert info.metadata == {}
        assert info.provider_definition is None
        assert info.resources == []
        assert info.actions == []


@pytest.mark.unit
class TestProviderRequest:
    def test_minimal_construction(self) -> None:
        req = ProviderRequest(provider="openai", method="POST", endpoint="/chat")
        assert req.provider == "openai"
        assert req.method == "POST"
        assert req.endpoint == "/chat"
        assert req.resource is None
        assert req.action is None
        assert req.params == {}
        assert req.headers == {}
        assert req.body is None
        assert req.stream is False

    def test_full_construction(self) -> None:
        req = ProviderRequest(
            provider="anthropic",
            method="POST",
            endpoint="/messages",
            resource="claude-3",
            action="complete",
            params={"key": "val"},
            headers={"X-Custom": "hdr"},
            body={"messages": []},
            stream=True,
        )
        assert req.resource == "claude-3"
        assert req.action == "complete"
        assert req.body == {"messages": []}
        assert req.stream is True


@pytest.mark.unit
class TestProviderResponse:
    def test_defaults(self) -> None:
        resp = ProviderResponse(status_code=200, data={"ok": True})
        assert resp.error is None
        assert resp.latency_ms == 0.0

    def test_error_response(self) -> None:
        resp = ProviderResponse(status_code=500, data={}, error="internal")
        assert resp.error == "internal"


@pytest.mark.unit
class TestGatewayHealthCheck:
    def test_construction(self) -> None:
        health_check = GatewayHealthCheck(healthy=True, latency_ms=42.5, authenticated=True)
        assert health_check.healthy is True
        assert health_check.latency_ms == 42.5
        assert health_check.authenticated is True
        assert health_check.error is None


@pytest.mark.unit
class TestGatewayProviderRequestHeaders:
    def _request(self, **kw) -> ProviderRequest:
        return ProviderRequest(provider="p", method="GET", endpoint="/e", **kw)

    def test_basic_headers_included(self) -> None:
        req = self._request()
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert headers["Authorization"] == "Bearer tok"
        assert headers["X-Caracal-Provider-ID"] == "openai"

    def test_accept_event_stream_when_enabled(self) -> None:
        req = self._request()
        headers = _gateway_provider_request_headers("tok", "p", req, accept_event_stream=True)
        assert headers["Accept"] == "text/event-stream"

    def test_no_accept_stream_by_default(self) -> None:
        req = self._request()
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert "Accept" not in headers

    def test_resource_header_added_when_present(self) -> None:
        req = self._request(resource="gpt-4")
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert headers["X-Caracal-Provider-Resource"] == "gpt-4"

    def test_no_resource_header_when_absent(self) -> None:
        req = self._request()
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert "X-Caracal-Provider-Resource" not in headers

    def test_action_header_added_when_present(self) -> None:
        req = self._request(action="invoke")
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert headers["X-Caracal-Provider-Action"] == "invoke"

    def test_no_action_header_when_absent(self) -> None:
        req = self._request()
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert "X-Caracal-Provider-Action" not in headers

    def test_custom_request_headers_merged(self) -> None:
        req = self._request(headers={"X-Custom": "value"})
        headers = _gateway_provider_request_headers("tok", "p", req)
        assert headers["X-Custom"] == "value"

    def test_resource_and_action_with_stream(self) -> None:
        req = self._request(resource="res", action="act")
        headers = _gateway_provider_request_headers(
            "tok", "p", req, accept_event_stream=True
        )
        assert headers["Accept"] == "text/event-stream"
        assert headers["X-Caracal-Provider-Resource"] == "res"
        assert headers["X-Caracal-Provider-Action"] == "act"


@pytest.mark.unit
class TestRequestPriority:
    def test_values(self) -> None:
        assert RequestPriority.LOW == "low"
        assert RequestPriority.NORMAL == "normal"
        assert RequestPriority.HIGH == "high"
        assert RequestPriority.CRITICAL == "critical"
