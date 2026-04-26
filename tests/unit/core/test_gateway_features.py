"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for GatewayFeatureFlags dataclass and pure helpers.
"""

import pytest

from caracal.core.gateway_features import (
    DEPLOYMENT_MANAGED,
    DEPLOYMENT_SELF_HOSTED,
    GatewayFeatureFlags,
    _bool_env,
    _int_env,
)

pytestmark = pytest.mark.unit


class TestBoolEnv:
    def test_true_values(self, monkeypatch):
        for val in ("1", "true", "yes", "TRUE", "YES"):
            monkeypatch.setenv("_TEST_FLAG", val)
            assert _bool_env("_TEST_FLAG") is True

    def test_false_values(self, monkeypatch):
        for val in ("0", "false", "no", "FALSE", "NO"):
            monkeypatch.setenv("_TEST_FLAG", val)
            assert _bool_env("_TEST_FLAG") is False

    def test_unknown_returns_default(self, monkeypatch):
        monkeypatch.setenv("_TEST_FLAG", "maybe")
        assert _bool_env("_TEST_FLAG", default=True) is True

    def test_missing_returns_default(self, monkeypatch):
        monkeypatch.delenv("_TEST_FLAG", raising=False)
        assert _bool_env("_TEST_FLAG", default=False) is False


class TestIntEnv:
    def test_parses_int(self, monkeypatch):
        monkeypatch.setenv("_TEST_INT", "300")
        assert _int_env("_TEST_INT", 0) == 300

    def test_invalid_value_returns_default(self, monkeypatch):
        monkeypatch.setenv("_TEST_INT", "notanumber")
        assert _int_env("_TEST_INT", 42) == 42

    def test_missing_returns_default(self, monkeypatch):
        monkeypatch.delenv("_TEST_INT", raising=False)
        assert _int_env("_TEST_INT", 99) == 99


class TestGatewayFeatureFlags:
    def test_defaults(self):
        flags = GatewayFeatureFlags()
        assert flags.gateway_enabled is False
        assert flags.enforce_at_network is False
        assert flags.fail_closed is True
        assert flags.gateway_endpoint is None
        assert flags.gateway_api_key is None
        assert flags.deployment_type == DEPLOYMENT_MANAGED
        assert flags.mandate_cache_ttl_seconds == 300
        assert flags.revocation_sync_interval_seconds == 30
        assert flags.use_provider_registry is False

    def test_is_managed_true(self):
        flags = GatewayFeatureFlags(deployment_type=DEPLOYMENT_MANAGED)
        assert flags.is_managed is True
        assert flags.is_self_hosted is False

    def test_is_self_hosted_true(self):
        flags = GatewayFeatureFlags(deployment_type=DEPLOYMENT_SELF_HOSTED)
        assert flags.is_self_hosted is True
        assert flags.is_managed is False

    def test_broker_fallback_allowed_when_gateway_disabled(self):
        flags = GatewayFeatureFlags(gateway_enabled=False)
        assert flags.broker_fallback_allowed is True

    def test_broker_fallback_not_allowed_when_gateway_enabled(self):
        flags = GatewayFeatureFlags(gateway_enabled=True)
        assert flags.broker_fallback_allowed is False

    def test_deployment_constants(self):
        assert DEPLOYMENT_MANAGED == "managed"
        assert DEPLOYMENT_SELF_HOSTED == "self_hosted"
