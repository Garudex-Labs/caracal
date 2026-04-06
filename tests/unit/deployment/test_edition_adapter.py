"""Unit tests for deployment edition adapter bootstrap behavior."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from caracal.deployment.edition import Edition
from caracal.deployment.edition_adapter import (
    DeploymentEditionAdapter,
    get_deployment_edition_adapter,
)
from caracal.deployment.exceptions import EditionConfigurationError


class _FakeEditionManager:
    def __init__(self, *, edition: Edition) -> None:
        self._edition = edition

    def get_edition(self) -> Edition:
        return self._edition

    def get_gateway_url(self) -> str | None:
        return "https://gateway.example" if self._edition == Edition.ENTERPRISE else None

    def get_gateway_token(self) -> str | None:
        return None

    def clear_cache(self) -> None:
        return None

    def set_edition(self, edition: Edition, gateway_url: str | None = None, gateway_token: str | None = None) -> None:
        del gateway_url, gateway_token
        self._edition = edition


@pytest.mark.unit
def test_get_adapter_enforces_startup_validation_when_requested(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bool] = []

    def _assert(self: DeploymentEditionAdapter) -> None:
        del self
        calls.append(True)

    monkeypatch.setattr(DeploymentEditionAdapter, "assert_enterprise_license_valid", _assert)

    get_deployment_edition_adapter(enforce_startup_license_validation=True)

    assert calls == [True]


@pytest.mark.unit
def test_assert_enterprise_license_valid_is_noop_for_opensource(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.OPENSOURCE))

    def _raise_if_called() -> dict[str, object]:
        raise AssertionError("license config should not be loaded in OSS mode")

    monkeypatch.setattr("caracal.deployment.enterprise_runtime.load_enterprise_config", _raise_if_called)

    adapter.assert_enterprise_license_valid()


@pytest.mark.unit
def test_assert_enterprise_license_valid_rejects_invalid_config(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))
    monkeypatch.setattr(
        "caracal.deployment.enterprise_runtime.load_enterprise_config",
        lambda: {"valid": False, "license_key": "license-1"},
    )

    with pytest.raises(EditionConfigurationError, match="requires a valid enterprise license"):
        adapter.assert_enterprise_license_valid()


@pytest.mark.unit
def test_assert_enterprise_license_valid_accepts_active_license(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    monkeypatch.setattr(
        "caracal.deployment.enterprise_runtime.load_enterprise_config",
        lambda: {"valid": True, "license_key": "license-1", "expires_at": expires_at},
    )

    adapter.assert_enterprise_license_valid()


@pytest.mark.unit
def test_get_provider_client_returns_broker_in_oss(monkeypatch: pytest.MonkeyPatch) -> None:
    import caracal.deployment.broker as broker_module

    class _FakeBroker:
        pass

    monkeypatch.setattr(broker_module, "Broker", _FakeBroker)

    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.OPENSOURCE))
    client = adapter.get_provider_client()

    assert isinstance(client, _FakeBroker)


@pytest.mark.unit
def test_get_provider_client_returns_gateway_in_enterprise(monkeypatch: pytest.MonkeyPatch) -> None:
    import caracal.deployment.gateway_client as gateway_client_module

    created: dict[str, str] = {}

    class _FakeGatewayClient:
        def __init__(self, gateway_url: str):
            created["gateway_url"] = gateway_url

    monkeypatch.setattr(gateway_client_module, "GatewayClient", _FakeGatewayClient)

    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))
    client = adapter.get_provider_client()

    assert isinstance(client, _FakeGatewayClient)
    assert created["gateway_url"] == "https://gateway.example"


@pytest.mark.unit
def test_require_gateway_url_uses_centralized_resolution() -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    assert adapter.require_gateway_url() == "https://gateway.example"


@pytest.mark.unit
def test_resolve_revocation_publisher_mode_defaults_from_edition() -> None:
    oss_adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.OPENSOURCE))
    enterprise_adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    assert oss_adapter.resolve_revocation_publisher_mode() == "redis"
    assert enterprise_adapter.resolve_revocation_publisher_mode() == "enterprise_webhook"


@pytest.mark.unit
def test_resolve_enterprise_revocation_target_requires_sync_key(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    monkeypatch.setattr(
        "caracal.deployment.enterprise_runtime.resolve_revocation_webhook_target",
        lambda webhook_url_override=None: (webhook_url_override or "https://enterprise.example/api/sync/revocation-events", None),
    )

    with pytest.raises(EditionConfigurationError, match="requires a sync API key"):
        adapter.resolve_enterprise_revocation_target(
            webhook_url_override="https://enterprise.example/custom-revocations",
        )


@pytest.mark.unit
def test_resolve_enterprise_revocation_target_uses_override_sync_key(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    monkeypatch.setattr(
        "caracal.deployment.enterprise_runtime.resolve_revocation_webhook_target",
        lambda webhook_url_override=None: (webhook_url_override or "https://enterprise.example/api/sync/revocation-events", "persisted-sync"),
    )

    webhook_url, sync_api_key = adapter.resolve_enterprise_revocation_target(
        webhook_url_override="https://enterprise.example/custom-revocations",
        sync_api_key_override="override-sync",
    )

    assert webhook_url == "https://enterprise.example/custom-revocations"
    assert sync_api_key == "override-sync"


@pytest.mark.unit
def test_adapter_capability_helpers_reflect_edition() -> None:
    oss_adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.OPENSOURCE))
    enterprise_adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    assert oss_adapter.display_name() == "Open Source"
    assert oss_adapter.uses_gateway_execution() is False
    assert oss_adapter.allows_local_provider_management() is True

    assert enterprise_adapter.display_name() == "Enterprise"
    assert enterprise_adapter.uses_gateway_execution() is True
    assert enterprise_adapter.allows_local_provider_management() is False


@pytest.mark.unit
def test_resolve_gateway_feature_overrides_is_noop_for_opensource(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.OPENSOURCE))

    def _raise_if_called() -> dict[str, object]:
        raise AssertionError("enterprise config should not be loaded in OSS mode")

    monkeypatch.setattr("caracal.deployment.enterprise_runtime.load_enterprise_config", _raise_if_called)

    assert adapter.resolve_gateway_feature_overrides() == {}


@pytest.mark.unit
def test_resolve_gateway_feature_overrides_normalizes_enterprise_gateway_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = DeploymentEditionAdapter(edition_manager=_FakeEditionManager(edition=Edition.ENTERPRISE))

    monkeypatch.setattr(
        "caracal.deployment.enterprise_runtime.load_enterprise_config",
        lambda: {
            "gateway": {
                "enabled": True,
                "endpoint": "https://enterprise.example/gateway/",
                "api_key": "sync-key-123",
                "fail_closed": True,
                "use_provider_registry": True,
                "mandate_cache_ttl_seconds": 42,
                "revocation_sync_interval_seconds": 7,
                "deployment_type": "managed",
            }
        },
    )

    overrides = adapter.resolve_gateway_feature_overrides()

    assert overrides["enabled"] is True
    assert overrides["endpoint"] == "https://enterprise.example/gateway"
    assert overrides["api_key"] == "sync-key-123"
    assert overrides["fail_closed"] is True
    assert overrides["use_provider_registry"] is True
    assert overrides["mandate_cache_ttl_seconds"] == 42
    assert overrides["revocation_sync_interval_seconds"] == 7
    assert overrides["deployment_type"] == "managed"
