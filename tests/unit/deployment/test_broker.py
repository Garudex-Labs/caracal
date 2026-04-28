"""Unit tests for OSS broker auth semantics."""

from __future__ import annotations

import ipaddress
from unittest.mock import Mock

import pytest

from caracal.deployment import broker as broker_module
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
        self.requests: list[dict] = []

    async def get(self, *_args, **_kwargs):
        self.calls.append("GET")
        self.requests.append({"args": _args, "kwargs": _kwargs})
        return self._response

    async def post(self, *_args, **_kwargs):
        self.calls.append("POST")
        self.requests.append({"args": _args, "kwargs": _kwargs})
        return self._response

    async def put(self, *_args, **_kwargs):
        self.calls.append("PUT")
        self.requests.append({"args": _args, "kwargs": _kwargs})
        return self._response

    async def patch(self, *_args, **_kwargs):
        self.calls.append("PATCH")
        self.requests.append({"args": _args, "kwargs": _kwargs})
        return self._response

    async def delete(self, *_args, **_kwargs):
        self.calls.append("DELETE")
        self.requests.append({"args": _args, "kwargs": _kwargs})
        return self._response


@pytest.fixture(autouse=True)
def _public_provider_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        broker_module,
        "resolve_provider_host_addresses",
        lambda _hostname: [ipaddress.ip_address("93.184.216.34")],
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


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_rejects_private_dns_resolution_before_request(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        broker_module,
        "resolve_provider_host_addresses",
        lambda _hostname: [ipaddress.ip_address("10.0.0.5")],
    )

    with pytest.raises(ProviderConfigurationError, match="resolved to"):
        await broker._call_provider_with_retry(
            provider="acme",
            config=config,
            request=BrokerRequest(provider="acme", method="GET", endpoint="health"),
        )

    assert fake_client.calls == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_rejects_dns_resolution_failure_before_request(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    def _fail_dns(_hostname):
        raise ProviderConfigurationError("Provider base_url hostname could not be resolved: api.example")

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(broker_module, "resolve_provider_host_addresses", _fail_dns)

    with pytest.raises(ProviderConfigurationError, match="could not be resolved"):
        await broker._call_provider_with_retry(
            provider="acme",
            config=config,
            request=BrokerRequest(provider="acme", method="GET", endpoint="health"),
        )

    assert fake_client.calls == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_allows_public_https_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    response = await broker._call_provider_with_retry(
        provider="acme",
        config=config,
        request=BrokerRequest(provider="acme", method="GET", endpoint="health"),
    )

    assert response.status_code == 200
    assert fake_client.calls == ["GET"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_allows_localhost_only_in_explicit_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CCL_ENV_MODE", "dev")
    monkeypatch.setenv("CCL_ALLOW_INTERNAL_PROVIDER_URLS", "true")
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="local",
        provider_type="application",
        credential_ref="caracal:default/providers/local/credential",
        base_url="http://localhost:8099",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})

    response = await broker._call_provider_with_retry(
        provider="local",
        config=config,
        request=BrokerRequest(provider="local", method="GET", endpoint="health"),
    )

    assert response.status_code == 200
    assert fake_client.calls == ["GET"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_allows_private_dns_only_in_explicit_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CCL_ENV_MODE", "test")
    monkeypatch.setenv("CCL_ALLOW_INTERNAL_PROVIDER_URLS", "true")
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="internal",
        provider_type="application",
        credential_ref="caracal:default/providers/internal/credential",
        base_url="https://provider.internal.example",
        auth_scheme="none",
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        broker_module,
        "resolve_provider_host_addresses",
        lambda _hostname: [ipaddress.ip_address("10.0.0.5")],
    )

    response = await broker._call_provider_with_retry(
        provider="internal",
        config=config,
        request=BrokerRequest(provider="internal", method="GET", endpoint="health"),
    )

    assert response.status_code == 200
    assert fake_client.calls == ["GET"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_broker_rejects_reserved_headers_and_auth_headers_win(monkeypatch: pytest.MonkeyPatch) -> None:
    broker = Broker(config_manager=Mock(), workspace="test")
    config = ProviderConfig(
        name="acme",
        provider_type="application",
        credential_ref="caracal:default/providers/acme/credential",
        base_url="https://api.example",
        auth_scheme="bearer",
        default_headers={"X-Trace": "default", "Authorization": "Bearer default"},
    )
    fake_client = _FakeProviderClient(_FakeResponse(200, {"ok": True}))

    async def _get_client():
        return fake_client

    monkeypatch.setattr(broker, "_get_client", _get_client)
    monkeypatch.setattr(broker, "_build_auth_headers", lambda *_args, **_kwargs: {"Authorization": "Bearer provider"})

    response = await broker._call_provider_with_retry(
        provider="acme",
        config=config,
        request=BrokerRequest(
            provider="acme",
            method="GET",
            endpoint="health",
            headers={"X-Request": "caller"},
        ),
    )

    assert response.status_code == 200
    assert fake_client.requests[-1]["kwargs"]["headers"]["Authorization"] == "Bearer provider"

    with pytest.raises(ProviderConfigurationError, match="reserved outbound headers"):
        await broker._call_provider_with_retry(
            provider="acme",
            config=config,
            request=BrokerRequest(
                provider="acme",
                method="GET",
                endpoint="health",
                headers={"Cookie": "sid=secret"},
            ),
        )
