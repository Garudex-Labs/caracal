"""Unit tests for broker/gateway boundary auth semantics."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from caracal.deployment.broker import Broker, ProviderConfig, ProviderRequest as BrokerRequest
from caracal.deployment.exceptions import (
    GatewayAuthorizationError,
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

    async def get(self, *_args, **_kwargs):
        return self._response

    async def post(self, *_args, **_kwargs):
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
