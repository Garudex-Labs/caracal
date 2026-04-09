"""Unit tests for AIS-only gateway token sourcing behavior."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

from caracal.deployment.exceptions import GatewayAuthenticationError
from caracal.deployment.gateway_client import GatewayClient


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.content = b"{}"

    def json(self) -> dict:
        return self._payload


class _FakeGatewayHttpClient:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    async def post(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


@pytest.mark.unit
@pytest.mark.asyncio
async def test_authenticate_rejects_non_human_when_ais_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "automation")
    monkeypatch.delenv("CARACAL_AIS_BASE_URL", raising=False)
    monkeypatch.delenv("CARACAL_AIS_UNIX_SOCKET_PATH", raising=False)

    config_manager = Mock()
    client = GatewayClient(
        gateway_url="https://gateway.example",
        config_manager=config_manager,
        workspace="test",
    )

    with pytest.raises(GatewayAuthenticationError, match="AIS token endpoint"):
        await client._authenticate()

    config_manager.get_secret.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_authenticate_rejects_human_when_ais_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "human")
    monkeypatch.delenv("CARACAL_AIS_BASE_URL", raising=False)
    monkeypatch.delenv("CARACAL_AIS_UNIX_SOCKET_PATH", raising=False)

    config_manager = Mock()
    client = GatewayClient(
        gateway_url="https://gateway.example",
        config_manager=config_manager,
        workspace="test",
    )

    with pytest.raises(GatewayAuthenticationError, match="AIS token endpoint"):
        await client._authenticate()

    config_manager.get_secret.assert_not_called()


@pytest.mark.unit
def test_build_ais_token_payload_requires_identity_triplet(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "automation")
    monkeypatch.setenv("CARACAL_AIS_BASE_URL", "http://ais.local")
    monkeypatch.delenv("CARACAL_AIS_PRINCIPAL_ID", raising=False)
    monkeypatch.delenv("CARACAL_AIS_ORGANIZATION_ID", raising=False)
    monkeypatch.delenv("CARACAL_AIS_TENANT_ID", raising=False)

    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")

    assert client._build_ais_token_payload() is None


@pytest.mark.unit
def test_parse_ais_expiration_falls_back_to_short_ttl() -> None:
    expires_at = GatewayClient._parse_ais_expiration({"access_token": "x"})

    assert expires_at > datetime.now(timezone.utc)
    assert expires_at <= datetime.now(timezone.utc) + timedelta(minutes=6)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_authenticate_via_ais_uses_http_endpoint_for_non_human(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "automation")
    monkeypatch.setenv("CARACAL_AIS_BASE_URL", "http://ais.local")
    monkeypatch.delenv("CARACAL_AIS_UNIX_SOCKET_PATH", raising=False)
    monkeypatch.setenv("CARACAL_AIS_PRINCIPAL_ID", "principal-1")
    monkeypatch.setenv("CARACAL_AIS_ORGANIZATION_ID", "org-1")
    monkeypatch.setenv("CARACAL_AIS_TENANT_ID", "tenant-1")

    captured: dict[str, object] = {}

    class _FakeAisClient:
        def __init__(self, *args, **kwargs) -> None:
            captured["init_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, **kwargs):
            captured["url"] = url
            captured["payload"] = kwargs.get("json")
            captured["headers"] = kwargs.get("headers")
            return _FakeResponse(
                200,
                {
                    "access_token": "ais-access-token",
                    "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat(),
                },
            )

    monkeypatch.setattr("caracal.deployment.gateway_client.httpx.AsyncClient", _FakeAisClient)

    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")

    success = await client._authenticate_via_ais()

    assert success is True
    assert captured["url"] == "http://ais.local/v1/ais/token"
    assert captured["payload"] == {
        "principal_id": "principal-1",
        "organization_id": "org-1",
        "tenant_id": "tenant-1",
        "session_kind": "automation",
        "include_refresh": True,
    }
    assert captured["headers"] is None
    assert client._token is not None
    assert client._token.token == "ais-access-token"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_authenticate_via_ais_sends_caller_token_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "automation")
    monkeypatch.setenv("CARACAL_AIS_BASE_URL", "http://ais.local")
    monkeypatch.setenv("CARACAL_AIS_PRINCIPAL_ID", "principal-1")
    monkeypatch.setenv("CARACAL_AIS_ORGANIZATION_ID", "org-1")
    monkeypatch.setenv("CARACAL_AIS_TENANT_ID", "tenant-1")
    monkeypatch.setenv("CARACAL_AIS_CALLER_TOKEN", "caller-access-token")

    captured: dict[str, object] = {}

    class _FakeAisClient:
        def __init__(self, *args, **kwargs) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, **kwargs):
            captured["headers"] = kwargs.get("headers")
            return _FakeResponse(
                200,
                {
                    "access_token": "ais-access-token",
                    "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat(),
                },
            )

    monkeypatch.setattr("caracal.deployment.gateway_client.httpx.AsyncClient", _FakeAisClient)

    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")
    success = await client._authenticate_via_ais()

    assert success is True
    assert captured["headers"] == {"Authorization": "Bearer caller-access-token"}


@pytest.mark.unit
def test_build_ais_token_payload_includes_attestation_nonce(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CARACAL_SESSION_KIND", "automation")
    monkeypatch.setenv("CARACAL_AIS_BASE_URL", "http://ais.local")
    monkeypatch.setenv("CARACAL_AIS_PRINCIPAL_ID", "principal-1")
    monkeypatch.setenv("CARACAL_AIS_ORGANIZATION_ID", "org-1")
    monkeypatch.setenv("CARACAL_AIS_TENANT_ID", "tenant-1")
    monkeypatch.setenv("CARACAL_AIS_ATTESTATION_NONCE", "nonce-123")

    client = GatewayClient(gateway_url="https://gateway.example", config_manager=Mock(), workspace="test")
    payload = client._build_ais_token_payload()

    assert payload is not None
    assert payload["attestation_nonce"] == "nonce-123"
