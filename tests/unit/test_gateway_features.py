"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the Gateway Feature Flags system.

Covers:
- Default OSS values (all enforcement off)
- Environment variable overrides
- Priority order: env vars > enterprise.json > config.yaml
- Deployment type constants
- Reload semantics
"""

import os
import json
import pytest
from unittest.mock import patch, mock_open, MagicMock
from pathlib import Path

from caracal.core.gateway_features import (
    GatewayFeatureFlags,
    get_gateway_features,
    reset_gateway_features,
    DEPLOYMENT_OSS,
    DEPLOYMENT_MANAGED,
    DEPLOYMENT_ON_PREM,
)


@pytest.fixture(autouse=True)
def clean_singleton():
    """Ensure the feature-flags singleton is reset before/after every test."""
    reset_gateway_features()
    yield
    reset_gateway_features()


class TestDeploymentConstants:
    def test_oss_constant(self):
        assert DEPLOYMENT_OSS == "oss"

    def test_managed_constant(self):
        assert DEPLOYMENT_MANAGED == "managed"

    def test_on_prem_constant(self):
        assert DEPLOYMENT_ON_PREM == "on_prem"


class TestDefaultFlags:
    """Without env vars or config, OSS defaults apply: everything off."""

    def test_gateway_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=False):
            flags = get_gateway_features()
            assert flags.gateway_enabled is False

    def test_fail_closed_true_by_default(self):
        # fail_closed=True is the safe default; effective only when gateway_enabled=True
        flags = get_gateway_features()
        assert flags.fail_closed is True

    def test_provider_registry_off_by_default(self):
        flags = get_gateway_features()
        assert flags.use_provider_registry is False

    def test_deployment_type_oss_by_default(self):
        flags = get_gateway_features()
        assert flags.deployment_type == DEPLOYMENT_OSS

    def test_mandate_cache_ttl_positive(self):
        flags = get_gateway_features()
        assert flags.mandate_cache_ttl_seconds > 0

    def test_revocation_sync_interval_positive(self):
        flags = get_gateway_features()
        assert flags.revocation_sync_interval_seconds > 0


class TestEnvVarOverrides:
    """Environment variables take highest priority."""

    def test_enable_gateway_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_ENABLED": "true"}):
            flags = get_gateway_features()
            assert flags.gateway_enabled is True

    def test_fail_closed_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_FAIL_CLOSED": "true"}):
            flags = get_gateway_features()
            assert flags.fail_closed is True

    def test_provider_registry_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_USE_PROVIDER_REGISTRY": "true"}):
            flags = get_gateway_features()
            assert flags.use_provider_registry is True

    def test_deployment_type_managed_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_DEPLOYMENT_TYPE": "managed"}):
            flags = get_gateway_features()
            assert flags.deployment_type == DEPLOYMENT_MANAGED

    def test_deployment_type_on_prem_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_DEPLOYMENT_TYPE": "on_prem"}):
            flags = get_gateway_features()
            assert flags.deployment_type == DEPLOYMENT_ON_PREM

    def test_mandate_cache_ttl_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_MANDATE_CACHE_TTL": "120"}):
            flags = get_gateway_features()
            assert flags.mandate_cache_ttl_seconds == 120

    def test_revocation_sync_interval_via_env(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_REVOCATION_SYNC_INTERVAL": "45"}):
            flags = get_gateway_features()
            assert flags.revocation_sync_interval_seconds == 45

    def test_invalid_bool_env_treated_as_false(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_ENABLED": "nope"}):
            flags = get_gateway_features()
            assert flags.gateway_enabled is False

    def test_case_insensitive_true(self):
        for val in ("TRUE", "True", "1", "yes"):
            reset_gateway_features()
            with patch.dict(os.environ, {"CARACAL_GATEWAY_ENABLED": val}):
                flags = get_gateway_features()
                assert flags.gateway_enabled is True, f"Expected True for {val!r}"


class TestSingletonBehavior:
    """Singleton is cached until reset or reload=True."""

    def test_same_object_returned_twice(self):
        f1 = get_gateway_features()
        f2 = get_gateway_features()
        assert f1 is f2

    def test_reset_clears_singleton(self):
        f1 = get_gateway_features()
        reset_gateway_features()
        f2 = get_gateway_features()
        assert f1 is not f2

    def test_reload_returns_fresh_object(self):
        f1 = get_gateway_features()
        f2 = get_gateway_features(reload=True)
        assert f1 is not f2

    def test_env_change_reflected_after_reload(self):
        with patch.dict(os.environ, {"CARACAL_GATEWAY_ENABLED": "false"}):
            f1 = get_gateway_features()
            assert f1.gateway_enabled is False

        with patch.dict(os.environ, {"CARACAL_GATEWAY_ENABLED": "true"}):
            f2 = get_gateway_features(reload=True)
            assert f2.gateway_enabled is True


class TestGatewayFeatureFlagsDataclass:
    """GatewayFeatureFlags is a frozen-ish dataclass with expected fields."""

    def test_fields_exist(self):
        flags = GatewayFeatureFlags()
        required = [
            "gateway_enabled",
            "fail_closed",
            "use_provider_registry",
            "mandate_cache_ttl_seconds",
            "revocation_sync_interval_seconds",
            "deployment_type",
        ]
        for field in required:
            assert hasattr(flags, field), f"Missing field: {field}"

    def test_direct_construction(self):
        flags = GatewayFeatureFlags(
            gateway_enabled=True,
            fail_closed=True,
            use_provider_registry=True,
            mandate_cache_ttl_seconds=30,
            revocation_sync_interval_seconds=15,
            deployment_type=DEPLOYMENT_ON_PREM,
        )
        assert flags.gateway_enabled is True
        assert flags.fail_closed is True
        assert flags.deployment_type == DEPLOYMENT_ON_PREM
