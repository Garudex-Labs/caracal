"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for configuration settings helpers.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
import yaml

from caracal.config.settings import (
    CaracalConfig,
    DatabaseConfig,
    StorageConfig,
    _decrypt_config_values,
    _expand_env_vars,
    _has_encrypted_values,
    _normalize_legacy_config_data,
    _normalize_hardcut_merkle_config_data,
    _persist_normalized_workspace_config,
    _validate_config,
    load_config,
)


@pytest.mark.unit
class TestExpandEnvVars:
    def test_plain_string_unchanged(self) -> None:
        assert _expand_env_vars("hello") == "hello"

    def test_substitutes_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("MY_HOST", "db.example.com")
        assert _expand_env_vars("${MY_HOST}") == "db.example.com"

    def test_missing_var_uses_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("UNSET_VAR", raising=False)
        assert _expand_env_vars("${UNSET_VAR:fallback}") == "fallback"

    def test_missing_var_no_default_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("UNSET_VAR", raising=False)
        assert _expand_env_vars("${UNSET_VAR}") == ""

    def test_embedded_var_in_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DB_PORT", "5432")
        result = _expand_env_vars("host:${DB_PORT}/db")
        assert result == "host:5432/db"

    def test_multiple_vars_in_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("H", "localhost")
        monkeypatch.setenv("P", "5432")
        result = _expand_env_vars("${H}:${P}")
        assert result == "localhost:5432"

    def test_dict_values_expanded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HOST", "myhost")
        result = _expand_env_vars({"host": "${HOST}"})
        assert result == {"host": "myhost"}

    def test_list_values_expanded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("URL", "http://srv")
        result = _expand_env_vars(["${URL}", "static"])
        assert result == ["http://srv", "static"]

    def test_non_string_passthrough(self) -> None:
        assert _expand_env_vars(42) == 42
        assert _expand_env_vars(True) is True
        assert _expand_env_vars(None) is None

    def test_nested_dict_expanded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INNER", "val")
        result = _expand_env_vars({"outer": {"inner": "${INNER}"}})
        assert result == {"outer": {"inner": "val"}}


@pytest.mark.unit
class TestHasEncryptedValues:
    def test_encrypted_string_detected(self) -> None:
        assert _has_encrypted_values("ENC[v4:abc123]") is True

    def test_plain_string_not_encrypted(self) -> None:
        assert _has_encrypted_values("plain-value") is False

    def test_dict_with_encrypted_value(self) -> None:
        assert _has_encrypted_values({"key": "ENC[v4:data]"}) is True

    def test_dict_without_encrypted_value(self) -> None:
        assert _has_encrypted_values({"key": "plain"}) is False

    def test_list_with_encrypted_value(self) -> None:
        assert _has_encrypted_values(["plain", "ENC[v4:data]"]) is True

    def test_list_without_encrypted_values(self) -> None:
        assert _has_encrypted_values(["plain", "also-plain"]) is False

    def test_nested_encrypted(self) -> None:
        assert _has_encrypted_values({"outer": {"key": "ENC[v4:data]"}}) is True

    def test_non_string_non_collection(self) -> None:
        assert _has_encrypted_values(42) is False
        assert _has_encrypted_values(None) is False


@pytest.mark.unit
class TestDatabaseConfigConnectionUrl:
    def test_basic_url(self) -> None:
        db = DatabaseConfig(host="localhost", port=5432, database="mydb", user="u", password="p")
        url = db.get_connection_url()
        assert url == "postgresql://u:p@localhost:5432/mydb"

    def test_password_with_special_chars_encoded(self) -> None:
        db = DatabaseConfig(host="h", port=5432, database="d", user="u", password="p@ss!")
        url = db.get_connection_url()
        assert "p%40ss%21" in url

    def test_empty_password(self) -> None:
        db = DatabaseConfig(host="h", port=5432, database="d", user="u", password="")
        url = db.get_connection_url()
        assert url == "postgresql://u:@h:5432/d"


@pytest.mark.unit
class TestLoadConfig:
    def test_missing_file_returns_defaults(self, tmp_path: Path) -> None:
        missing = str(tmp_path / "nonexistent.yaml")
        config = load_config(missing)
        assert isinstance(config, CaracalConfig)

    def test_empty_file_returns_defaults(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        cfg.write_text("")
        config = load_config(str(cfg))
        assert isinstance(config, CaracalConfig)

    def test_valid_yaml_parsed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_VAULT_MERKLE_KEY", "vault://caracal/merkle-key")
        monkeypatch.setenv("CCL_VAULT_MERKLE_PUB", "vault://caracal/merkle-pub")
        cfg = tmp_path / "config.yaml"
        cfg.write_text(
            yaml.safe_dump(
                {
                    "storage": {"backup_dir": str(tmp_path / "backups"), "backup_count": 3},
                    "merkle": {
                        "signing_backend": "vault",
                        "vault_key_ref": "vault://caracal/merkle-key",
                        "vault_public_key_ref": "vault://caracal/merkle-pub",
                    },
                }
            )
        )
        config = load_config(str(cfg))
        assert isinstance(config, CaracalConfig)
        assert config.storage.backup_dir == str(tmp_path / "backups")

    def test_malformed_yaml_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = tmp_path / "config.yaml"
        cfg.write_bytes(b"invalid:\n  - yaml: [\n")
        with pytest.raises(InvalidConfigurationError):
            load_config(str(cfg))

    def test_redis_defaults(self, tmp_path: Path) -> None:
        config = load_config(str(tmp_path / "nope.yaml"))
        assert config.redis.host == "localhost"
        assert config.redis.port == 6379

    def test_suppress_missing_file_log(self, tmp_path: Path) -> None:
        config = load_config(str(tmp_path / "absent.yaml"), suppress_missing_file_log=True)
        assert isinstance(config, CaracalConfig)

    def test_emit_logs_false_suppresses(self, tmp_path: Path) -> None:
        config = load_config(str(tmp_path / "absent.yaml"), emit_logs=False)
        assert isinstance(config, CaracalConfig)

    def test_decrypt_config_import_error_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        with patch(
            "caracal.config.settings._has_encrypted_values", return_value=True
        ), patch.dict(
            "sys.modules", {"caracal.config.encryption": None}
        ):
            with pytest.raises((InvalidConfigurationError, ImportError)):
                _decrypt_config_values({"key": "ENC[v4:abc]"})

    def test_missing_storage_section_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = tmp_path / "config.yaml"
        cfg.write_text(yaml.safe_dump({"defaults": {"time_window": "daily"}}))
        with pytest.raises(InvalidConfigurationError, match="storage"):
            load_config(str(cfg))


@pytest.mark.unit
class TestNormalizeHardcutMerkleConfigData:
    def test_forces_vault_backend(self) -> None:
        config, changed = _normalize_hardcut_merkle_config_data(
            {"merkle": {"signing_backend": "software"}}
        )
        assert config["merkle"]["signing_backend"] == "vault"
        assert changed is True

    def test_stays_unchanged_when_already_vault(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("CCL_VAULT_MERKLE_SIGNING_KEY_REF", raising=False)
        monkeypatch.delenv("CCL_VAULT_MERKLE_PUB_KEY_REF", raising=False)
        config, changed = _normalize_hardcut_merkle_config_data(
            {
                "merkle": {
                    "signing_backend": "vault",
                    "signing_algorithm": "ES256",
                    "vault_key_ref": "k",
                    "vault_public_key_ref": "p",
                }
            }
        )
        assert changed is False

    def test_removes_private_key_path(self) -> None:
        config, changed = _normalize_hardcut_merkle_config_data(
            {
                "merkle": {
                    "signing_backend": "vault",
                    "signing_algorithm": "ES256",
                    "vault_key_ref": "k",
                    "vault_public_key_ref": "p",
                    "private_key_path": "/tmp/legacy.pem",
                }
            }
        )
        assert "private_key_path" not in config.get("merkle", {})
        assert changed is True

    def test_non_dict_passthrough(self) -> None:
        result, changed = _normalize_hardcut_merkle_config_data("invalid")
        assert result == "invalid"
        assert changed is False

    def test_missing_merkle_section_normalized(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("CCL_VAULT_MERKLE_SIGNING_KEY_REF", raising=False)
        monkeypatch.delenv("CCL_VAULT_MERKLE_PUB_KEY_REF", raising=False)
        config, changed = _normalize_hardcut_merkle_config_data({})
        assert config["merkle"]["signing_backend"] == "vault"
        assert changed is True


@pytest.mark.unit
class TestNormalizeLegacyConfigData:
    def test_rewrites_legacy_env_placeholders(self) -> None:
        config, changed = _normalize_legacy_config_data(
            {
                "storage": {"backup_dir": "${CARACAL_HOME:~/.caracal}/backups"},
                "database": {
                    "host": "${CARACAL_DB_HOST:localhost}",
                    "password": "${CARACAL_DB_PASSWORD:caracal}",
                },
                "mcp_adapter": {
                    "listen_address": "${CARACAL_MCP_LISTEN_ADDRESS:0.0.0.0:8080}",
                },
            }
        )

        assert changed is True
        assert config["storage"]["backup_dir"] == "${CCL_HOME:~/.caracal}/backups"
        assert config["database"]["host"] == "${CCL_DB_HOST:localhost}"
        assert config["database"]["password"] == "${CCL_DB_PASSWORD:caracal}"
        assert config["mcp_adapter"]["listen_address"] == "${CCL_MCP_LISTEN_ADDR:0.0.0.0:8080}"

    def test_removes_legacy_demo_upstream_default(self) -> None:
        config, changed = _normalize_legacy_config_data(
            {
                "mcp_adapter": {
                    "mcp_server_urls": [
                        {
                            "name": "demo-upstream",
                            "url": "http://host.docker.internal:8090",
                            "timeout_seconds": 30,
                        }
                    ]
                }
            }
        )

        assert changed is True
        assert config["mcp_adapter"]["mcp_server_urls"] == []


@pytest.mark.unit
class TestPersistNormalizedWorkspaceConfig:
    def test_writes_back_config_yaml(self, tmp_path: Path) -> None:
        cfg = tmp_path / "config.yaml"
        cfg.write_text("")
        data = {"storage": {"backup_dir": "/tmp"}}
        _persist_normalized_workspace_config(str(cfg), data)
        content = cfg.read_text()
        assert "backup_dir" in content

    def test_ignores_non_config_filename(self, tmp_path: Path) -> None:
        other = tmp_path / "settings.yaml"
        other.write_text("original: value")
        _persist_normalized_workspace_config(str(other), {"key": "new"})
        assert other.read_text() == "original: value"

    def test_ignores_missing_file(self, tmp_path: Path) -> None:
        missing = tmp_path / "config.yaml"
        _persist_normalized_workspace_config(str(missing), {"key": "val"})


@pytest.mark.unit
class TestValidateConfig:
    def _base_config(self, tmp_path: Path) -> CaracalConfig:
        from caracal.config.settings import get_default_config
        return get_default_config()

    def test_invalid_backup_count_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = self._base_config(tmp_path)
        cfg.storage.backup_count = 0
        with pytest.raises(InvalidConfigurationError, match="backup_count"):
            _validate_config(cfg)

    def test_invalid_time_window_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = self._base_config(tmp_path)
        cfg.defaults.time_window = "weekly"
        with pytest.raises(InvalidConfigurationError, match="time_window"):
            _validate_config(cfg)

    def test_invalid_log_level_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = self._base_config(tmp_path)
        cfg.logging.level = "VERBOSE"
        with pytest.raises(InvalidConfigurationError, match="logging level"):
            _validate_config(cfg)

    def test_invalid_policy_eval_timeout_raises(self, tmp_path: Path) -> None:
        from caracal.exceptions import InvalidConfigurationError
        cfg = self._base_config(tmp_path)
        cfg.performance.policy_eval_timeout_ms = 0
        with pytest.raises(InvalidConfigurationError, match="policy_eval_timeout_ms"):
            _validate_config(cfg)
