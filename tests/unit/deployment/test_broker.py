"""Unit tests for OSS broker auth semantics."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from caracal.deployment.broker import (
    Broker,
    ProviderConfig,
    ProviderRequest as BrokerRequest,
    ProviderResponse,
)
from caracal.deployment.exceptions import (
    ProviderConfigurationError,
    ProviderAuthorizationError,
)


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.headers = {}
        self.content = b"{}"

    def json(self) -> dict:
        return self._payload


class _FakeProviderClient:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls: list[str] = []

    async def get(self, *_args, **_kwargs):
        self.calls.append("GET")
        return self._response

    async def post(self, *_args, **_kwargs):
        self.calls.append("POST")
        return self._response

    async def put(self, *_args, **_kwargs):
        self.calls.append("PUT")
        return self._response

    async def patch(self, *_args, **_kwargs):
        self.calls.append("PATCH")
        return self._response

    async def delete(self, *_args, **_kwargs):
        self.calls.append("DELETE")
        return self._response


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

    assert fake_client.calls == ["GET"]


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


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_scoped_mode_rejects_unscoped_request() -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    broker.configure_provider(
        "openai",
        ProviderConfig(
            name="openai",
            provider_type="ai",
            auth_scheme="none",
            enforce_scoped_requests=True,
            definition={
                "resources": {
                    "models": {
                        "actions": {
                            "list": {
                                "method": "GET",
                                "path_prefix": "/v1/models",
                            }
                        }
                    }
                }
            },
        ),
    )

    with pytest.raises(ProviderConfigurationError, match="requires provider-scoped resource/action headers"):
        await broker.call_provider(
            "openai",
            BrokerRequest(
                provider="openai",
                method="GET",
                endpoint="/v1/models",
            ),
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_scoped_mode_allows_scoped_request(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    broker.configure_provider(
        "openai",
        ProviderConfig(
            name="openai",
            provider_type="ai",
            auth_scheme="none",
            enforce_scoped_requests=True,
            definition={
                "resources": {
                    "models": {
                        "actions": {
                            "list": {
                                "method": "GET",
                                "path_prefix": "/v1/models",
                            }
                        }
                    }
                }
            },
        ),
    )

    async def _fake_call_provider_with_retry(*_args, **_kwargs):
        return ProviderResponse(status_code=200, data={"ok": True})

    monkeypatch.setattr(broker, "_call_provider_with_retry", _fake_call_provider_with_retry)

    response = await broker.call_provider(
        "openai",
        BrokerRequest(
            provider="openai",
            method="GET",
            endpoint="/v1/models",
            resource="provider:openai:resource:models",
            action="provider:openai:action:list",
        ),
    )

    assert response.status_code == 200
    assert response.data == {"ok": True}


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_broker_executes_put_patch_delete_methods(
    method: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"updated": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    response = await broker._call_provider_with_retry(
        provider="acme",
        config=config,
        request=BrokerRequest(provider="acme", method=method, endpoint="resource/1"),
    )

    assert response.status_code == 200
    assert fake_client.calls == [method]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_raises_on_missing_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url=None,
        auth_scheme="none",
    )

    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    with pytest.raises(ProviderConfigurationError, match="no base_url configured"):
        await broker._call_provider_with_retry(
            provider="acme",
            config=config,
            request=BrokerRequest(provider="acme", method="GET", endpoint="health"),
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_returns_empty_data_for_non_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    class _HtmlResponse:
        status_code = 200
        content = b"<html>Not JSON</html>"
        headers = {}

        def json(self):
            raise ValueError("not json")

    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="none",
    )

    async def _get_client():
        class _Client:
            async def get(self, *_a, **_kw):
                return _HtmlResponse()
        return _Client()

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    response = await broker._call_provider_with_retry(
        provider="acme",
        config=config,
        request=BrokerRequest(provider="acme", method="GET", endpoint="health"),
    )

    assert response.status_code == 200
    assert response.data == {}
