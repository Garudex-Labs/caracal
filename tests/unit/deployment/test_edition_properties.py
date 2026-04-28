"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for Edition enum properties and EditionManager methods.
"""

import os
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
import toml

from caracal.deployment.edition import Edition, EditionManager
from caracal.deployment.exceptions import (
    InvalidEditionError,
    EditionConfigurationError,
    EditionDetectionError,
)


pytestmark = pytest.mark.unit


class TestEditionEnum:
    def test_enterprise_is_enterprise(self):
        assert Edition.ENTERPRISE.is_enterprise is True

    def test_enterprise_not_opensource(self):
        assert Edition.ENTERPRISE.is_opensource is False

    def test_opensource_is_opensource(self):
        assert Edition.OPENSOURCE.is_opensource is True

    def test_opensource_not_enterprise(self):
        assert Edition.OPENSOURCE.is_enterprise is False

    def test_enterprise_value(self):
        assert Edition.ENTERPRISE.value == "enterprise"

    def test_opensource_value(self):
        assert Edition.OPENSOURCE.value == "opensource"

    def test_from_string_enterprise(self):
        assert Edition("enterprise") == Edition.ENTERPRISE

    def test_from_string_opensource(self):
        assert Edition("opensource") == Edition.OPENSOURCE


class TestEditionManagerClearCache:
    def _manager(self) -> EditionManager:
        m = EditionManager.__new__(EditionManager)
        m._cached_edition = None
        m._cache_timestamp = None
        return m

    def test_clear_cache_resets_edition(self):
        mgr = self._manager()
        mgr._cached_edition = Edition.ENTERPRISE
        mgr.clear_cache()
        assert mgr._cached_edition is None

    def test_clear_cache_resets_timestamp(self):
        from datetime import datetime
        mgr = self._manager()
        mgr._cache_timestamp = datetime.now()
        mgr.clear_cache()
        assert mgr._cache_timestamp is None

    def test_clear_cache_idempotent(self):
        mgr = self._manager()
        mgr.clear_cache()
        mgr.clear_cache()
        assert mgr._cached_edition is None


class TestEditionManagerGetEditionFromEnv:
    def _manager_with_config(self, tmp_path) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = None
        mgr._cache_timestamp = None
        mgr.CONFIG_DIR = tmp_path
        mgr.CONFIG_FILE = tmp_path / "config.toml"
        return mgr

    def test_env_gateway_enabled_1(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "1")
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.ENTERPRISE

    def test_env_gateway_enabled_true(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "true")
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.ENTERPRISE

    def test_env_gateway_disabled_0(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "0")
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.OPENSOURCE

    def test_env_gateway_disabled_false(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "false")
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.OPENSOURCE

    def test_no_env_no_config_defaults_opensource(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        monkeypatch.delenv("CCL_GATEWAY_ENABLED", raising=False)
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.OPENSOURCE

    def test_config_file_enterprise(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        config = {"edition": {"current": "enterprise"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        monkeypatch.delenv("CCL_GATEWAY_ENABLED", raising=False)
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.ENTERPRISE

    def test_config_file_opensource(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        config = {"edition": {"current": "opensource"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        monkeypatch.delenv("CCL_GATEWAY_ENABLED", raising=False)
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.OPENSOURCE

    def test_cached_edition_returned(self, tmp_path):
        mgr = self._manager_with_config(tmp_path)
        mgr._cached_edition = Edition.ENTERPRISE
        edition = mgr.get_edition()
        assert edition == Edition.ENTERPRISE

    def test_invalid_config_falls_back_to_default(self, tmp_path, monkeypatch):
        mgr = self._manager_with_config(tmp_path)
        (tmp_path / "config.toml").write_text("this is not toml [[[")
        monkeypatch.delenv("CCL_GATEWAY_ENABLED", raising=False)
        with patch.object(mgr, "_assert_execution_exclusivity"):
            edition = mgr.get_edition()
        assert edition == Edition.OPENSOURCE


class TestEditionManagerIsEnterpriseIsOpensource:
    def _manager_with_edition(self, edition: Edition) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = edition
        mgr._cache_timestamp = None
        return mgr

    def test_is_enterprise_true(self):
        mgr = self._manager_with_edition(Edition.ENTERPRISE)
        assert mgr.is_enterprise() is True

    def test_is_enterprise_false(self):
        mgr = self._manager_with_edition(Edition.OPENSOURCE)
        assert mgr.is_enterprise() is False

    def test_is_opensource_true(self):
        mgr = self._manager_with_edition(Edition.OPENSOURCE)
        assert mgr.is_opensource() is True

    def test_is_opensource_false(self):
        mgr = self._manager_with_edition(Edition.ENTERPRISE)
        assert mgr.is_opensource() is False


class TestEditionManagerGetGatewayUrl:
    def _manager(self, tmp_path) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = None
        mgr._cache_timestamp = None
        mgr.CONFIG_DIR = tmp_path
        mgr.CONFIG_FILE = tmp_path / "config.toml"
        return mgr

    def test_from_env_gateway_url(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_URL", "https://gateway.example.com")
        with patch("caracal.deployment.edition.EditionManager._gateway_url_from_config", return_value=None):
            url = mgr.get_gateway_url()
        assert url == "https://gateway.example.com"

    def test_from_config_file(self, tmp_path):
        mgr = self._manager(tmp_path)
        config = {"edition": {"gateway_url": "https://config.example.com"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        with patch("caracal.deployment.enterprise_runtime.load_enterprise_config", side_effect=Exception("no")):
            url = mgr.get_gateway_url()
        assert url == "https://config.example.com"

    def test_no_config_no_env_returns_none(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.delenv("CCL_GATEWAY_URL", raising=False)
        with patch("caracal.deployment.edition.EditionManager._gateway_url_from_config", return_value=None):
            url = mgr.get_gateway_url()
        assert url is None

    def test_config_takes_priority_over_env(self, tmp_path):
        mgr = self._manager(tmp_path)
        with patch.dict(os.environ, {"CCLE_URL": "https://env.example.com"}, clear=False):
            with patch("caracal.deployment.edition.EditionManager._gateway_url_from_config", return_value="https://cfg.example.com"):
                url = mgr.get_gateway_url()
        assert url == "https://cfg.example.com"


class TestEditionManagerGetGatewayToken:
    def _manager(self, tmp_path) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = None
        mgr._cache_timestamp = None
        mgr.CONFIG_DIR = tmp_path
        mgr.CONFIG_FILE = tmp_path / "config.toml"
        return mgr

    def test_returns_token_from_config(self, tmp_path):
        mgr = self._manager(tmp_path)
        config = {"edition": {"gateway_token": "mytoken123"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        assert mgr.get_gateway_token() == "mytoken123"

    def test_returns_none_when_no_config_file(self, tmp_path):
        mgr = self._manager(tmp_path)
        assert mgr.get_gateway_token() is None

    def test_returns_none_when_no_token_in_config(self, tmp_path):
        mgr = self._manager(tmp_path)
        config = {"edition": {"current": "enterprise"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        assert mgr.get_gateway_token() is None

    def test_returns_none_on_corrupt_config(self, tmp_path):
        mgr = self._manager(tmp_path)
        (tmp_path / "config.toml").write_text("[[[invalid toml")
        assert mgr.get_gateway_token() is None


class TestEditionManagerSetEdition:
    def _manager(self, tmp_path) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = None
        mgr._cache_timestamp = None
        mgr.CONFIG_DIR = tmp_path
        mgr.CONFIG_FILE = tmp_path / "config.toml"
        return mgr

    def test_set_opensource_writes_config(self, tmp_path):
        mgr = self._manager(tmp_path)
        mgr.set_edition(Edition.OPENSOURCE)
        config = toml.load(tmp_path / "config.toml")
        assert config["edition"]["current"] == "opensource"

    def test_set_enterprise_writes_gateway_url(self, tmp_path):
        mgr = self._manager(tmp_path)
        mgr.set_edition(Edition.ENTERPRISE, gateway_url="https://gateway.example.com")
        config = toml.load(tmp_path / "config.toml")
        assert config["edition"]["current"] == "enterprise"
        assert config["edition"]["gateway_url"] == "https://gateway.example.com"

    def test_set_enterprise_without_gateway_raises(self, tmp_path):
        mgr = self._manager(tmp_path)
        with pytest.raises(EditionConfigurationError, match="Gateway URL"):
            mgr.set_edition(Edition.ENTERPRISE)

    def test_set_invalid_edition_raises(self, tmp_path):
        mgr = self._manager(tmp_path)
        with pytest.raises(InvalidEditionError):
            mgr.set_edition("enterprise")  # type: ignore

    def test_set_edition_updates_cache(self, tmp_path):
        mgr = self._manager(tmp_path)
        mgr.set_edition(Edition.OPENSOURCE)
        assert mgr._cached_edition == Edition.OPENSOURCE

    def test_set_enterprise_with_token(self, tmp_path):
        mgr = self._manager(tmp_path)
        mgr.set_edition(Edition.ENTERPRISE, gateway_url="https://gateway.example.com", gateway_token="tok123")
        config = toml.load(tmp_path / "config.toml")
        assert config["edition"]["gateway_token"] == "tok123"

    def test_set_opensource_removes_gateway_config(self, tmp_path):
        mgr = self._manager(tmp_path)
        config = {"edition": {"current": "enterprise", "gateway_url": "https://old.com", "gateway_token": "oldtok"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        mgr.set_edition(Edition.OPENSOURCE)
        written = toml.load(tmp_path / "config.toml")
        assert "gateway_url" not in written["edition"]
        assert "gateway_token" not in written["edition"]


class TestEditionManagerAutoDetect:
    def _manager(self, tmp_path) -> EditionManager:
        mgr = EditionManager.__new__(EditionManager)
        mgr._cached_edition = None
        mgr._cache_timestamp = None
        mgr.CONFIG_DIR = tmp_path
        mgr.CONFIG_FILE = tmp_path / "config.toml"
        return mgr

    def test_env_yes_signals_enterprise(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "yes")
        edition = mgr._auto_detect_edition()
        assert edition == Edition.ENTERPRISE

    def test_env_on_signals_enterprise(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "on")
        edition = mgr._auto_detect_edition()
        assert edition == Edition.ENTERPRISE

    def test_env_no_signals_opensource(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "no")
        edition = mgr._auto_detect_edition()
        assert edition == Edition.OPENSOURCE

    def test_env_off_signals_opensource(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        monkeypatch.setenv("CCL_GATEWAY_ENABLED", "off")
        edition = mgr._auto_detect_edition()
        assert edition == Edition.OPENSOURCE

    def test_garbage_config_value_defaults_opensource(self, tmp_path, monkeypatch):
        mgr = self._manager(tmp_path)
        config = {"edition": {"current": "invalid_value"}}
        (tmp_path / "config.toml").write_text(toml.dumps(config))
        monkeypatch.delenv("CCL_GATEWAY_ENABLED", raising=False)
        edition = mgr._auto_detect_edition()
        assert edition == Edition.OPENSOURCE
