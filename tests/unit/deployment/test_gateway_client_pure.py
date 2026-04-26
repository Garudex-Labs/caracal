"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for GatewayClient dataclasses and pure methods.
"""

import pytest
from collections import deque
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import httpx

from caracal.deployment.gateway_client import (
    RequestPriority,
    ProviderRequest,
    ProviderResponse,
    ProviderInfo,
    GatewayHealthCheck,
    QuotaStatus,
    QueuedRequest,
    JWTToken,
    GatewayClient,
    _gateway_provider_request_headers,
)


pytestmark = pytest.mark.unit


class TestRequestPriority:
    def test_low_value(self):
        assert RequestPriority.LOW.value == "low"

    def test_normal_value(self):
        assert RequestPriority.NORMAL.value == "normal"

    def test_high_value(self):
        assert RequestPriority.HIGH.value == "high"

    def test_critical_value(self):
        assert RequestPriority.CRITICAL.value == "critical"


class TestProviderRequest:
    def test_required_fields(self):
        req = ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")
        assert req.provider == "openai"
        assert req.method == "POST"
        assert req.endpoint == "/v1/chat"

    def test_defaults(self):
        req = ProviderRequest(provider="openai", method="GET", endpoint="/v1/models")
        assert req.resource is None
        assert req.action is None
        assert req.params == {}
        assert req.headers == {}
        assert req.body is None
        assert req.stream is False


class TestProviderResponse:
    def test_required_fields(self):
        resp = ProviderResponse(status_code=200, data={"result": "ok"})
        assert resp.status_code == 200
        assert resp.data == {"result": "ok"}

    def test_defaults(self):
        resp = ProviderResponse(status_code=200, data={})
        assert resp.error is None
        assert resp.latency_ms == 0.0


class TestProviderInfo:
    def test_service_type_alias(self):
        info = ProviderInfo(name="openai", provider_type="llm", available=True)
        assert info.service_type == "llm"

    def test_status_healthy(self):
        info = ProviderInfo(name="openai", provider_type="llm", available=True)
        assert info.status == "healthy"

    def test_status_unavailable(self):
        info = ProviderInfo(name="openai", provider_type="llm", available=False)
        assert info.status == "unavailable"

    def test_defaults(self):
        info = ProviderInfo(name="openai", provider_type="llm", available=True)
        assert info.quota_remaining is None
        assert info.tags == []
        assert info.metadata == {}


class TestGatewayHealthCheck:
    def test_fields(self):
        hc = GatewayHealthCheck(healthy=True, latency_ms=12.5, authenticated=True)
        assert hc.healthy is True
        assert hc.latency_ms == 12.5
        assert hc.authenticated is True
        assert hc.error is None


class TestQuotaStatus:
    def test_fields(self):
        qs = QuotaStatus(
            total_quota=1000,
            used_quota=200,
            remaining_quota=800,
            reset_at=datetime(2026, 1, 1),
            percentage_used=20.0,
        )
        assert qs.remaining_quota == 800
        assert qs.percentage_used == 20.0


class TestQueuedRequest:
    def _make_request(self):
        return ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")

    def test_not_expired_when_fresh(self):
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.NORMAL,
            queued_at=datetime.now(),
            ttl_seconds=3600,
        )
        assert req.is_expired() is False

    def test_expired_when_ttl_passed(self):
        req = QueuedRequest(
            request=self._make_request(),
            priority=RequestPriority.LOW,
            queued_at=datetime.now() - timedelta(seconds=7200),
            ttl_seconds=3600,
        )
        assert req.is_expired() is True


class TestJWTToken:
    def test_not_expired_when_future(self):
        token = JWTToken(
            token="mytoken",
            expires_at=datetime.now() + timedelta(hours=1),
        )
        assert token.is_expired() is False

    def test_expired_when_past(self):
        token = JWTToken(
            token="mytoken",
            expires_at=datetime.now() - timedelta(hours=1),
        )
        assert token.is_expired() is True

    def test_expired_within_buffer(self):
        token = JWTToken(
            token="mytoken",
            expires_at=datetime.now() + timedelta(seconds=30),
        )
        assert token.is_expired(buffer_seconds=60) is True

    def test_not_expired_before_buffer(self):
        token = JWTToken(
            token="mytoken",
            expires_at=datetime.now() + timedelta(seconds=90),
        )
        assert token.is_expired(buffer_seconds=60) is False


class TestGatewayProviderRequestHeaders:
    def _make_request(self, resource=None, action=None, headers=None):
        return ProviderRequest(
            provider="openai",
            method="POST",
            endpoint="/v1/chat",
            resource=resource,
            action=action,
            headers=headers or {},
        )

    def test_includes_authorization(self):
        req = self._make_request()
        headers = _gateway_provider_request_headers("mytoken", "openai", req)
        assert headers["Authorization"] == "Bearer mytoken"

    def test_includes_provider_header(self):
        req = self._make_request()
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert headers["X-Caracal-Provider-ID"] == "openai"

    def test_includes_resource_when_set(self):
        req = self._make_request(resource="gpt-4")
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert headers["X-Caracal-Provider-Resource"] == "gpt-4"

    def test_no_resource_header_when_not_set(self):
        req = self._make_request()
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert "X-Caracal-Provider-Resource" not in headers

    def test_includes_action_when_set(self):
        req = self._make_request(action="complete")
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert headers["X-Caracal-Provider-Action"] == "complete"

    def test_event_stream_accept_header(self):
        req = self._make_request()
        headers = _gateway_provider_request_headers("tok", "openai", req, accept_event_stream=True)
        assert headers["Accept"] == "text/event-stream"

    def test_no_event_stream_without_flag(self):
        req = self._make_request()
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert "Accept" not in headers

    def test_merges_custom_headers(self):
        req = self._make_request(headers={"X-Custom": "value"})
        headers = _gateway_provider_request_headers("tok", "openai", req)
        assert headers["X-Custom"] == "value"


def _make_client() -> GatewayClient:
    with patch("caracal.deployment.gateway_client.ConfigManager"):
        client = GatewayClient.__new__(GatewayClient)
        client.gateway_url = "https://gw.example.com"
        client.workspace = "default"
        client.max_queue_size = 100
        client.default_ttl_seconds = 3600
        client._token = None
        client._request_queue = deque(maxlen=100)
        client._quota_status = None
        client._last_quota_check = None
        client._client = None
        return client


class TestGatewayRequestUrl:
    def test_builds_url_with_endpoint(self):
        client = _make_client()
        url = client._gateway_request_url("/v1/providers")
        assert url == "https://gw.example.com/v1/providers"

    def test_strips_leading_slash(self):
        client = _make_client()
        url = client._gateway_request_url("v1/providers")
        assert url == "https://gw.example.com/v1/providers"

    def test_strips_trailing_slash_from_base(self):
        with patch("caracal.deployment.gateway_client.ConfigManager"):
            client = GatewayClient.__new__(GatewayClient)
            client.gateway_url = "https://gw.example.com/"
            url = client._gateway_request_url("/test")
        assert url == "https://gw.example.com//test"


class TestExtractGatewayDenial:
    def _mock_response(self, json_data=None, status_code=403):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = status_code
        if json_data is None:
            resp.json.side_effect = ValueError("no json")
        else:
            resp.json.return_value = json_data
        return resp

    def test_extracts_from_error_dict(self):
        resp = self._mock_response({"error": {"code": "AUTH_DENIED", "message": "Not allowed"}})
        code, msg = GatewayClient._extract_gateway_denial(resp)
        assert code == "AUTH_DENIED"
        assert msg == "Not allowed"

    def test_extracts_from_error_string(self):
        resp = self._mock_response({"error": "Access denied"})
        code, msg = GatewayClient._extract_gateway_denial(resp)
        assert msg == "Access denied"

    def test_extracts_from_message_field(self):
        resp = self._mock_response({"message": "Forbidden"})
        code, msg = GatewayClient._extract_gateway_denial(resp)
        assert msg == "Forbidden"

    def test_defaults_on_json_error(self):
        resp = self._mock_response(json_data=None)
        code, msg = GatewayClient._extract_gateway_denial(resp)
        assert code == "BOUNDARY_2_OR_3_DENY"
        assert "403" in msg


class TestUpdateQuotaFromHeaders:
    def _headers(self, data):
        return httpx.Headers(data)

    def test_updates_quota_when_headers_present(self):
        client = _make_client()
        headers = self._headers({
            "X-Quota-Remaining": "800",
            "X-Quota-Total": "1000",
            "X-Quota-Reset": "2026-12-31T23:59:59",
        })
        client._update_quota_from_headers(headers)
        assert client._quota_status is not None
        assert client._quota_status.remaining_quota == 800

    def test_no_update_when_no_quota_header(self):
        client = _make_client()
        headers = self._headers({"Content-Type": "application/json"})
        client._update_quota_from_headers(headers)
        assert client._quota_status is None


class TestCleanupExpiredRequests:
    def _make_queued(self, expired=False):
        req = ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")
        return QueuedRequest(
            request=req,
            priority=RequestPriority.NORMAL,
            queued_at=datetime.now() - timedelta(hours=2 if expired else 0),
            ttl_seconds=3600,
        )

    def test_removes_expired(self):
        client = _make_client()
        client._request_queue.append(self._make_queued(expired=True))
        client._request_queue.append(self._make_queued(expired=False))
        client._cleanup_expired_requests()
        assert len(client._request_queue) == 1

    def test_keeps_fresh_requests(self):
        client = _make_client()
        client._request_queue.append(self._make_queued(expired=False))
        client._cleanup_expired_requests()
        assert len(client._request_queue) == 1


class TestRemoveLowestPriorityRequest:
    def _make_queued(self, priority: RequestPriority):
        req = ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")
        return QueuedRequest(
            request=req,
            priority=priority,
            queued_at=datetime.now(),
            ttl_seconds=3600,
        )

    def test_removes_low_priority(self):
        client = _make_client()
        client._request_queue.append(self._make_queued(RequestPriority.HIGH))
        client._request_queue.append(self._make_queued(RequestPriority.LOW))
        client._remove_lowest_priority_request()
        remaining = list(client._request_queue)
        assert len(remaining) == 1
        assert remaining[0].priority == RequestPriority.HIGH

    def test_does_nothing_on_empty_queue(self):
        client = _make_client()
        client._remove_lowest_priority_request()
        assert len(client._request_queue) == 0


class TestGetQueueSize:
    def test_returns_zero_on_empty(self):
        client = _make_client()
        assert client.get_queue_size() == 0

    def test_returns_correct_count(self):
        client = _make_client()
        req = ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")
        queued = QueuedRequest(req, RequestPriority.NORMAL, datetime.now(), 3600)
        client._request_queue.append(queued)
        assert client.get_queue_size() == 1


class TestClearQueue:
    def test_empties_queue(self):
        client = _make_client()
        req = ProviderRequest(provider="openai", method="POST", endpoint="/v1/chat")
        queued = QueuedRequest(req, RequestPriority.NORMAL, datetime.now(), 3600)
        client._request_queue.append(queued)
        client.clear_queue()
        assert client.get_queue_size() == 0
