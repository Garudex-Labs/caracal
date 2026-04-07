"""Unit tests for broker/gateway boundary auth semantics."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from caracal.deployment.broker import Broker, ProviderConfig, ProviderRequest as BrokerRequest
from caracal.deployment.exceptions import (
    GatewayAuthorizationError,
    ProviderConfigurationError,
    ProviderAuthorizationError,
)
from caracal.deployment.gateway_client import GatewayClient, ProviderRequest as GatewayRequest


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.headers = {}
        self.content = b"{}"

    def json(self) -> dict:
        return self._payload


class _FakeGatewayClient:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls: list[tuple[str, str, dict | None]] = []

    async def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self._response

    async def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self._response


class _FakeProviderClient:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls = 0

    async def get(self, *_args, **_kwargs):
        self.calls += 1
        return self._response

    async def post(self, *_args, **_kwargs):
        self.calls += 1
        return self._response


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gateway_client_raises_authorization_error_for_403(monkeypatch: pytest.MonkeyPatch) -> None:
    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")

    async def _token() -> str:
        return "token"

    async def _quota() -> None:
        return None

    async def _http_client():
        return _FakeGatewayClient(
            _FakeResponse(
                403,
                {
                    "error": {
                        "code": "AUTH_ACTION_SCOPE_DENIED",
                        "message": "Action is outside mandate scope",
                    }
                },
            )
        )

    monkeypatch.setattr(client, "_get_token", _token)
    monkeypatch.setattr(client, "_check_quota", _quota)
    monkeypatch.setattr(client, "_get_client", _http_client)

    with pytest.raises(GatewayAuthorizationError, match="AUTH_ACTION_SCOPE_DENIED"):
        await client.call_provider(
            provider="openai",
            request=GatewayRequest(
                provider="openai",
                method="GET",
                endpoint="models",
            ),
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gateway_client_uses_header_based_provider_routing_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")
    fake_client = _FakeGatewayClient(_FakeResponse(200, {"ok": True}))

    async def _token() -> str:
        return "token"

    async def _quota() -> None:
        return None

    async def _http_client():
        return fake_client

    monkeypatch.setattr(client, "_get_token", _token)
    monkeypatch.setattr(client, "_check_quota", _quota)
    monkeypatch.setattr(client, "_get_client", _http_client)

    response = await client.call_provider(
        provider="openai",
        request=GatewayRequest(
            provider="openai",
            method="GET",
            endpoint="/v1/models",
            resource="provider:openai:resource:models",
            action="provider:openai:action:list",
        ),
    )

    assert response.status_code == 200
    assert fake_client.calls == [
        (
            "GET",
            "https://gateway.example/v1/models",
            {
                "params": {},
                "headers": {
                    "Authorization": "Bearer token",
                    "X-Caracal-Provider-ID": "openai",
                    "X-Caracal-Provider-Resource": "provider:openai:resource:models",
                    "X-Caracal-Provider-Action": "provider:openai:action:list",
                },
                "timeout": 30.0,
            },
        )
    ]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_raises_authorization_error_for_403_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="openai",
        provider_type="api",
        credential_ref="secret/openai",
        base_url="https://api.example",
        max_retries=3,
    )

    fake_client = _FakeProviderClient(_FakeResponse(403, {"error": "forbidden"}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    with pytest.raises(ProviderAuthorizationError, match="Authorization denied"):
        await broker._call_provider_with_retry(
            provider="openai",
            config=config,
            request=BrokerRequest(
                provider="openai",
                method="GET",
                endpoint="models",
            ),
        )

    assert fake_client.calls == 1


@pytest.mark.unit
def test_broker_rejects_gateway_only_auth_scheme_in_oss() -> None:
    broker = Broker(config_manager=Mock(), workspace="test")

    with pytest.raises(ProviderConfigurationError, match="requires enterprise gateway execution"):
        broker.configure_provider(
            "gcs",
            ProviderConfig(
                name="gcs",
                provider_type="storage",
                auth_scheme="service_account",
                credential_ref="caracal:default/providers/gcs/credential",
                base_url="https://storage.example",
            ),
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_health_check_reports_structured_runtime_details(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    broker.configure_provider(
        "openai",
        ProviderConfig(
            name="openai",
            provider_type="ai",
            credential_ref="caracal:default/providers/openai/credential",
            base_url="https://api.example",
            auth_scheme="bearer",
        ),
    )

    async def _get_client():
        return _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {"Authorization": "Bearer sk-test"})

    health = await broker.test_provider("openai")

    assert health.healthy is True
    assert health.reachable is True
    assert health.status_code == 200
    assert health.auth_injected is True
    assert health.error is None
