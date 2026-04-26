"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for LicenseValidationResult and EnterpriseLicenseValidator.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from caracal.deployment.enterprise_license import (
    EnterpriseLicenseValidator,
    LicenseValidationResult,
)


@pytest.mark.unit
class TestLicenseValidationResultToDict:
    def test_valid_result(self):
        expires = datetime(2026, 1, 1, 12, 0, 0)
        result = LicenseValidationResult(
            valid=True,
            message="OK",
            features_available=["feature_a"],
            expires_at=expires,
            tier="pro",
            sync_api_key="sk-test",
            enterprise_api_url="https://api.garudexlabs.com",
        )
        d = result.to_dict()
        assert d["valid"] is True
        assert d["message"] == "OK"
        assert d["features_available"] == ["feature_a"]
        assert d["expires_at"] == expires.isoformat()
        assert d["tier"] == "pro"
        assert d["sync_api_key"] == "sk-test"
        assert d["enterprise_api_url"] == "https://api.garudexlabs.com"

    def test_none_expires_at(self):
        result = LicenseValidationResult(valid=False, message="No license")
        d = result.to_dict()
        assert d["expires_at"] is None

    def test_defaults(self):
        result = LicenseValidationResult(valid=False, message="x")
        d = result.to_dict()
        assert d["features_available"] == []
        assert d["tier"] is None
        assert d["sync_api_key"] is None
        assert d["enterprise_api_url"] is None


@pytest.mark.unit
class TestEnterpriseLicenseValidatorValidateLicense:
    def _validator(self, api_url="https://api.example.com"):
        with patch("caracal.deployment.enterprise_license._resolve_api_url", return_value=api_url):
            return EnterpriseLicenseValidator()

    def test_empty_token_returns_invalid(self):
        v = self._validator()
        result = v.validate_license("")
        assert result.valid is False
        assert "token" in result.message.lower() or "license" in result.message.lower()

    def test_whitespace_token_returns_invalid(self):
        v = self._validator()
        result = v.validate_license("   ")
        assert result.valid is False

    def test_no_api_url_returns_invalid(self):
        v = self._validator(api_url=None)
        result = v.validate_license("valid-token")
        assert result.valid is False
        assert "API URL" in result.message or "url" in result.message.lower()

    def _patched_meta(self):
        return (
            patch("caracal.deployment.enterprise_license._get_or_create_client_instance_id", return_value="inst-1"),
            patch("caracal.deployment.enterprise_license._build_client_metadata", return_value={}),
        )

    def test_connection_error_returns_invalid(self):
        v = self._validator()
        p1, p2 = self._patched_meta()
        with p1, p2, patch("caracal.deployment.enterprise_license._post_json", side_effect=ConnectionError("unreachable")):
            result = v.validate_license("valid-token")
        assert result.valid is False
        assert "reach" in result.message.lower() or "unavailable" in result.message.lower()

    def test_unexpected_error_returns_invalid(self):
        v = self._validator()
        p1, p2 = self._patched_meta()
        with p1, p2, patch("caracal.deployment.enterprise_license._post_json", side_effect=RuntimeError("unexpected")):
            result = v.validate_license("valid-token")
        assert result.valid is False

    def test_api_returns_invalid(self):
        v = self._validator()
        p1, p2 = self._patched_meta()
        with p1, p2, patch("caracal.deployment.enterprise_license._post_json", return_value={"valid": False, "message": "Bad key"}):
            result = v.validate_license("bad-token")
        assert result.valid is False
        assert result.message == "Bad key"

    def test_api_returns_valid(self):
        v = self._validator()
        resp = {
            "valid": True,
            "message": "License valid",
            "features": {"feature_a": True, "feature_b": False},
            "valid_until": "2026-01-01T00:00:00",
            "tier": "enterprise",
            "sync_api_key": "sk-abc",
            "enterprise_api_url": "https://api.example.com",
        }
        with patch("caracal.deployment.enterprise_license._post_json", return_value=resp):
            with patch("caracal.deployment.enterprise_license._get_or_create_client_instance_id", return_value="inst-1"):
                with patch("caracal.deployment.enterprise_license._build_client_metadata", return_value={}):
                    with patch("caracal.deployment.enterprise_license.save_enterprise_config"):
                        result = v.validate_license("good-token")
        assert result.valid is True
        assert result.tier == "enterprise"
        assert "feature_a" in result.features_available
        assert "feature_b" not in result.features_available


@pytest.mark.unit
class TestEnterpriseLicenseValidatorInfo:
    def _validator_with_config(self, cfg):
        with patch("caracal.deployment.enterprise_license._resolve_api_url", return_value=None):
            v = EnterpriseLicenseValidator()
        v._cached_config = cfg
        return v

    def test_get_available_features_empty(self):
        v = self._validator_with_config({})
        assert v.get_available_features() == []

    def test_get_available_features(self):
        v = self._validator_with_config({"feature_names": ["feat_a", "feat_b"]})
        assert v.get_available_features() == ["feat_a", "feat_b"]

    def test_is_feature_available_true(self):
        v = self._validator_with_config({"features": {"feat_a": True}})
        assert v.is_feature_available("feat_a") is True

    def test_is_feature_available_false(self):
        v = self._validator_with_config({"features": {"feat_a": False}})
        assert v.is_feature_available("feat_a") is False

    def test_is_feature_available_missing(self):
        v = self._validator_with_config({"features": {}})
        assert v.is_feature_available("nonexistent") is False

    def test_get_license_info_no_license(self):
        v = self._validator_with_config({})
        info = v.get_license_info()
        assert info["edition"] == "open_source"
        assert info["license_active"] is False

    def test_get_license_info_with_license(self):
        cfg = {
            "license_key": "key123",
            "tier": "pro",
            "feature_names": ["feat_a"],
            "expires_at": "2026-01-01",
            "sync_api_key": "sk-1",
            "enterprise_api_url": "https://api.example.com",
        }
        v = self._validator_with_config(cfg)
        info = v.get_license_info()
        assert info["edition"] == "enterprise"
        assert info["license_active"] is True
        assert info["tier"] == "pro"

    def test_is_connected_true(self):
        v = self._validator_with_config({"license_key": "k", "valid": True})
        assert v.is_connected() is True

    def test_is_connected_false_no_valid(self):
        v = self._validator_with_config({"license_key": "k", "valid": False})
        assert v.is_connected() is False

    def test_is_connected_false_no_key(self):
        v = self._validator_with_config({"valid": True})
        assert v.is_connected() is False

    def test_get_sync_api_key(self):
        v = self._validator_with_config({"sync_api_key": "sk-abc"})
        assert v.get_sync_api_key() == "sk-abc"

    def test_get_enterprise_api_url_from_config(self):
        v = self._validator_with_config({"enterprise_api_url": "https://api.example.com"})
        assert v.get_enterprise_api_url() == "https://api.example.com"

    def test_disconnect_clears_cache(self):
        v = self._validator_with_config({"license_key": "k"})
        with patch("caracal.deployment.enterprise_license.clear_enterprise_config"):
            v.disconnect()
        assert v._cached_config is None

    def test_api_url_property(self):
        with patch("caracal.deployment.enterprise_license._resolve_api_url", return_value="https://api.test.com"):
            v = EnterpriseLicenseValidator()
        assert v.api_url == "https://api.test.com"
