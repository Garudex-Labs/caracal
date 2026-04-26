"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for configuration settings helpers.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from caracal.config.settings import (
    CaracalConfig,
    DatabaseConfig,
    StorageConfig,
    _expand_env_vars,
    _has_encrypted_values,
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
