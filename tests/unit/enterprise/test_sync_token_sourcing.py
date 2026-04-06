"""Unit tests for enterprise sync token sourcing behavior."""

from __future__ import annotations

import json

import pytest

import caracal.enterprise.license as enterprise_license
import caracal.enterprise.sync as enterprise_sync


@pytest.fixture
def patched_client_factory(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(enterprise_sync, "_resolve_api_url", lambda _override=None: "https://enterprise.example")
    monkeypatch.setattr(enterprise_sync, "_get_or_create_client_instance_id", lambda: "client-1")

    def _factory(*, sync_api_key: str | None = "sync-key"):
        monkeypatch.setattr(enterprise_sync, "load_enterprise_config", lambda: {})
        return enterprise_sync.EnterpriseSyncClient(
            sync_api_key=sync_api_key,
        )

    return _factory


@pytest.mark.unit
def test_sync_uses_canonical_sync_key_headers(
    patched_client_factory,
) -> None:
    client = patched_client_factory(sync_api_key="sync-local")
    headers = client._resolve_enterprise_auth_headers()

    assert headers["X-Caracal-Client-Id"] == "client-1"
    assert headers["X-Sync-Api-Key"] == "sync-local"
    assert "Authorization" not in headers


@pytest.mark.unit
def test_sync_headers_require_configured_sync_api_key(
    patched_client_factory,
) -> None:
    client = patched_client_factory(sync_api_key=None)

    with pytest.raises(RuntimeError, match="requires a configured sync API key"):
        client._resolve_enterprise_auth_headers()


@pytest.mark.unit
def test_sync_client_requires_sync_key_to_be_configured(
    patched_client_factory,
) -> None:
    assert patched_client_factory(sync_api_key="sync-local").is_configured is True
    assert patched_client_factory(sync_api_key=None).is_configured is False


@pytest.mark.unit
def test_sync_upload_payload_has_no_auth_fallback_fields(
    monkeypatch: pytest.MonkeyPatch,
    patched_client_factory,
) -> None:
    captured_payload: dict[str, object] = {}

    monkeypatch.setattr(enterprise_sync, "_load_local_principals", lambda: [{"principal_id": "p1"}])
    monkeypatch.setattr(enterprise_sync, "_load_local_policies", lambda: [])
    monkeypatch.setattr(enterprise_sync, "_load_local_mandates", lambda: [])
    monkeypatch.setattr(enterprise_sync, "_load_local_ledger", lambda: [])
    monkeypatch.setattr(enterprise_sync, "_load_local_delegation", lambda: [])
    monkeypatch.setattr(enterprise_sync, "_candidate_api_urls", lambda base_url: [base_url])
    monkeypatch.setattr(enterprise_sync, "save_enterprise_config", lambda _cfg: None)
    monkeypatch.setattr(
        enterprise_sync.EnterpriseSyncClient,
        "pull_gateway_config",
        lambda self: {"success": True, "message": "ok"},
    )

    class _FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            del exc_type, exc, tb
            return False

        def read(self) -> bytes:
            return json.dumps({"success": True, "message": "ok", "synced_counts": {}}).encode()

    def _capture_urlopen(req, timeout=30):
        del timeout
        captured_payload.update(json.loads(req.data.decode()))
        return _FakeResponse()

    monkeypatch.setattr(enterprise_sync.urllib.request, "urlopen", _capture_urlopen)

    client = patched_client_factory(sync_api_key="sync-local")
    result = client.sync()

    assert result.success is True
    assert "sync_api_key" not in captured_payload
    assert "license_key" not in captured_payload


@pytest.mark.unit
def test_sync_status_uses_header_auth_without_license_query_fallback(
    monkeypatch: pytest.MonkeyPatch,
    patched_client_factory,
) -> None:
    captured: dict[str, object] = {}

    def _capture_get(url: str, headers: dict[str, str] | None = None) -> dict[str, object]:
        captured["url"] = url
        captured["headers"] = dict(headers or {})
        return {"success": True}

    monkeypatch.setattr(enterprise_sync, "_get_json", _capture_get)

    client = patched_client_factory(sync_api_key="sync-local")
    status = client.get_sync_status()

    assert status == {"success": True}
    assert captured["url"] == "https://enterprise.example/api/sync/status"
    assert captured["headers"]["X-Sync-Api-Key"] == "sync-local"
    assert "Authorization" not in captured["headers"]


@pytest.mark.unit
def test_resolve_revocation_webhook_target_uses_override_and_cached_sync_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        enterprise_license,
        "load_enterprise_config",
        lambda: {"sync_api_key": "sync-key-1"},
    )

    webhook_url, sync_api_key = enterprise_license.resolve_revocation_webhook_target(
        webhook_url_override="https://enterprise.example/custom-revocations",
    )

    assert webhook_url == "https://enterprise.example/custom-revocations"
    assert sync_api_key == "sync-key-1"


@pytest.mark.unit
def test_resolve_revocation_webhook_target_builds_default_sync_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        enterprise_license,
        "load_enterprise_config",
        lambda: {
            "enterprise_api_url": "https://enterprise.example",
            "sync_api_key": "sync-key-2",
        },
    )
    monkeypatch.setattr(
        enterprise_license,
        "_resolve_api_url",
        lambda override=None: (override or "https://enterprise.example").rstrip("/"),
    )

    webhook_url, sync_api_key = enterprise_license.resolve_revocation_webhook_target()

    assert webhook_url == "https://enterprise.example/api/sync/revocation-events"
    assert sync_api_key == "sync-key-2"


@pytest.mark.unit
def test_license_validation_fails_closed_when_api_url_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enterprise_license, "_resolve_api_url", lambda override=None: "")

    validator = enterprise_license.EnterpriseLicenseValidator()
    result = validator.validate_license("license-key-1")

    assert result.valid is False
    assert "requires a live Enterprise API" in result.message


@pytest.mark.unit
def test_license_validation_fails_closed_when_api_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enterprise_license, "_resolve_api_url", lambda override=None: "https://enterprise.example")
    monkeypatch.setattr(
        enterprise_license,
        "_candidate_api_urls",
        lambda base_url: [base_url],
    )
    monkeypatch.setattr(enterprise_license, "_get_or_create_client_instance_id", lambda: "client-1")
    monkeypatch.setattr(
        enterprise_license,
        "_post_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ConnectionError("offline")),
    )

    validator = enterprise_license.EnterpriseLicenseValidator()
    result = validator.validate_license("license-key-1")

    assert result.valid is False
    assert "requires a live Enterprise API" in result.message


@pytest.mark.unit
def test_license_validation_request_has_no_password_field(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_payload: dict[str, object] = {}

    monkeypatch.setattr(enterprise_license, "_resolve_api_url", lambda override=None: "https://enterprise.example")
    monkeypatch.setattr(enterprise_license, "_candidate_api_urls", lambda base_url: [base_url])
    monkeypatch.setattr(enterprise_license, "_get_or_create_client_instance_id", lambda: "client-1")

    def _capture_post(_url: str, payload: dict, timeout: int = 15) -> dict:
        captured_payload.update(payload)
        return {
            "valid": True,
            "message": "ok",
            "tier": "starter",
            "features": {},
            "enterprise_api_url": "https://enterprise.example",
        }

    monkeypatch.setattr(enterprise_license, "_post_json", _capture_post)
    monkeypatch.setattr(
        enterprise_license.EnterpriseLicenseValidator,
        "_persist_license",
        lambda self, **kwargs: None,
    )

    validator = enterprise_license.EnterpriseLicenseValidator()
    result = validator.validate_license("license-key-1")

    assert result.valid is True
    assert "password" not in captured_payload


@pytest.mark.unit
def test_resolve_api_url_ignores_removed_legacy_gateway_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enterprise_license, "load_enterprise_config", lambda: {})
    monkeypatch.setattr(enterprise_license, "_load_workspace_dotenv", lambda: {})
    monkeypatch.delenv("CARACAL_ENTERPRISE_URL", raising=False)
    monkeypatch.delenv("CARACAL_ENTERPRISE_DEV_URL", raising=False)
    monkeypatch.delenv("CARACAL_ENTERPRISE_DEFAULT_URL", raising=False)
    monkeypatch.setenv("CARACAL_ENTERPRISE_API_URL", "https://legacy-enterprise.example")
    monkeypatch.setenv("CARACAL_GATEWAY_URL", "https://legacy-gateway.example")

    resolved = enterprise_license._resolve_api_url()

    assert resolved == "https://www.garudexlabs.com"
