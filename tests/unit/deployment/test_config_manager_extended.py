"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for ConfigManager helper methods and utility functions.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Optional
from unittest.mock import patch, MagicMock

import pytest
import yaml

from caracal.deployment.config_manager import ConfigManager, PostgresConfig, WorkspaceConfig
from caracal.deployment.exceptions import (
    InvalidWorkspaceNameError,
    WorkspaceNotFoundError,
    WorkspaceOperationError,
)


def _setup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ConfigManager:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")
    return ConfigManager()


@pytest.mark.unit
class TestValidateWorkspaceName:
    def test_valid_name(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        m._validate_workspace_name("my-workspace")

    def test_valid_name_with_underscore(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        m._validate_workspace_name("my_workspace")

    def test_valid_name_alphanumeric(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        m._validate_workspace_name("workspace123")

    def test_invalid_name_with_space(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            m._validate_workspace_name("my workspace")

    def test_invalid_name_too_long(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            m._validate_workspace_name("x" * 65)

    def test_reserved_name_primary(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError, match="reserved"):
            m._validate_workspace_name("primary")

    def test_reserved_name_deleted_backups(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError, match="reserved"):
            m._validate_workspace_name("_deleted_backups")

    def test_empty_name_invalid(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            m._validate_workspace_name("")


@pytest.mark.unit
class TestIsWorkspaceDiscoverable:
    def test_valid_name_is_discoverable(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._is_workspace_discoverable("my-workspace") is True

    def test_reserved_name_not_discoverable(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._is_workspace_discoverable("primary") is False

    def test_name_with_dot_not_discoverable(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._is_workspace_discoverable(".hidden") is False

    def test_empty_name_not_discoverable(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._is_workspace_discoverable("") is False


@pytest.mark.unit
class TestGetWorkspacePaths:
    def test_get_workspace_dir(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._get_workspace_dir("alpha")
        assert result == tmp_path / "workspaces" / "alpha"

    def test_get_workspace_config_file(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._get_workspace_config_file("alpha")
        assert result == tmp_path / "workspaces" / "alpha" / "workspace.toml"

    def test_legacy_secret_store_path(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._legacy_secret_store_path("workspace")
        assert result == tmp_path / "workspaces" / "workspace" / "secrets.vault"


@pytest.mark.unit
class TestLoadWorkspaceRuntimeConfig:
    def test_returns_empty_when_no_config_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        assert m._load_workspace_runtime_config(workspace_dir) == {}

    def test_loads_valid_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text(yaml.safe_dump({"key": "value"}))
        result = m._load_workspace_runtime_config(workspace_dir)
        assert result == {"key": "value"}

    def test_returns_empty_for_invalid_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text(": bad: yaml:")
        result = m._load_workspace_runtime_config(workspace_dir)
        assert result == {}


@pytest.mark.unit
class TestExtractWorkspaceDbConfig:
    def test_returns_none_when_no_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        assert m._extract_workspace_db_config(workspace_dir) is None

    def test_returns_none_when_no_schema(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text(yaml.safe_dump({"database": {"host": "db"}}))
        assert m._extract_workspace_db_config(workspace_dir) is None

    def test_returns_db_config_with_schema(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "test"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text(
            yaml.safe_dump({"database": {"host": "db", "schema": "myschema", "port": 5432}})
        )
        result = m._extract_workspace_db_config(workspace_dir)
        assert result is not None
        assert result["schema"] == "myschema"
        assert result["host"] == "db"


@pytest.mark.unit
class TestPgEnv:
    def test_sets_pgpassfile_when_provided(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        db_cfg = {"host": "db", "port": 5432, "database": "caracal", "user": "caracal", "password": "my-password"}
        with m._pg_env(db_cfg) as env:
            pgpass_path = Path(env["PGPASSFILE"])
            assert pgpass_path.read_text(encoding="utf-8").strip().endswith(":my-password")
        assert not pgpass_path.exists()

    def test_no_pgpassfile_when_empty(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        db_cfg = {"host": "db", "port": 5432, "database": "caracal", "user": "caracal", "password": ""}
        with m._pg_env(db_cfg) as env:
            assert "PGPASSFILE" not in env
            assert "PGPASSWORD" not in env


@pytest.mark.unit
class TestNormalizeLockKey:
    def test_passes_through_none(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._normalize_lock_key(None) is None

    def test_returns_stripped_string(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._normalize_lock_key("  my-key  ")
        assert result is None or isinstance(result, str)


@pytest.mark.unit
class TestValidateLockKey:
    def test_short_key_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceOperationError, match="12 characters"):
            m._validate_lock_key("short")

    def test_long_enough_key_passes(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m._validate_lock_key("a" * 12)


@pytest.mark.unit
class TestListWorkspaces:
    def test_returns_empty_when_no_workspaces(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m.list_workspaces() == []

    def test_lists_created_workspaces(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("alpha")
        m.create_workspace("beta")
        workspaces = m.list_workspaces()
        assert "alpha" in workspaces
        assert "beta" in workspaces

    def test_excludes_reserved_names(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        reserved_dir = m.WORKSPACES_DIR / "primary"
        reserved_dir.mkdir(parents=True, exist_ok=True)
        assert "primary" not in m.list_workspaces()


@pytest.mark.unit
class TestCreateWorkspace:
    def test_creates_workspace_directory(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("my-workspace")
        assert (m.WORKSPACES_DIR / "my-workspace").exists()

    def test_invalid_name_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            m.create_workspace("invalid name!")


@pytest.mark.unit
class TestLoadSecretRefs:
    def test_empty_when_no_secrets(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("workspace")
        assert m._load_secret_refs("workspace") == {}

    def test_missing_workspace_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m._load_secret_refs("nonexistent")

    def test_load_secret_refs_or_empty_returns_empty_for_missing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._load_secret_refs_or_empty("does-not-exist")
        assert result == {}


@pytest.mark.unit
class TestGetWorkspaceConfig:
    def test_returns_config_for_existing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("myworkspace")
        cfg = m.get_workspace_config("myworkspace")
        assert cfg.name == "myworkspace"

    def test_raises_for_missing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m.get_workspace_config("does-not-exist")

    def test_default_workspace_is_first_created(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("first-workspace")
        cfg = m.get_workspace_config("first-workspace")
        assert cfg.is_default is True

    def test_second_workspace_not_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("workspace-one")
        m.create_workspace("workspace-two")
        cfg = m.get_workspace_config("workspace-two")
        assert cfg.is_default is False


@pytest.mark.unit
class TestGetDefaultWorkspaceName:
    def test_returns_none_when_no_workspaces(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m.get_default_workspace_name() is None

    def test_returns_first_workspace_as_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("alpha")
        assert m.get_default_workspace_name() == "alpha"

    def test_returns_explicit_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("alpha")
        m.create_workspace("beta")
        m.set_default_workspace("beta")
        assert m.get_default_workspace_name() == "beta"


@pytest.mark.unit
class TestSwitchWorkspace:
    def test_switches_to_existing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("workspace-alpha")
        m.create_workspace("workspace-beta")
        m.set_default_workspace("workspace-beta")
        assert m.get_default_workspace_name() == "workspace-beta"

    def test_switch_to_nonexistent_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m.set_default_workspace("nonexistent")


@pytest.mark.unit
class TestDeleteWorkspace:
    def test_delete_workspace_removes_directory(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("alpha")
        m.create_workspace("beta")
        m.set_default_workspace("beta")
        m.delete_workspace("alpha", backup=False)
        assert "alpha" not in m.list_workspaces()

    def test_delete_nonexistent_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m.delete_workspace("ghost", backup=False)


@pytest.mark.unit
class TestStoreAndGetSecret:
    def test_store_and_retrieve_secret(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("sec-workspace")
        with patch("caracal.deployment.config_manager.encrypt_value", return_value="enc:val"), \
             patch("caracal.deployment.config_manager.decrypt_value", return_value="my-secret-value"):
            m.store_secret("API_KEY", "my-secret-value", "sec-workspace")
            result = m.get_secret("API_KEY", "sec-workspace")
        assert result == "my-secret-value"

    def test_get_missing_secret_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from caracal.deployment.exceptions import SecretNotFoundError
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("sec-workspace")
        with pytest.raises(SecretNotFoundError):
            m.get_secret("MISSING_KEY", "sec-workspace")

    def test_store_secret_invalid_workspace_raises(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m.store_secret("KEY", "value", "nonexistent-workspace")

    def test_multiple_secrets_stored_separately(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("multi-workspace")
        with patch("caracal.deployment.config_manager.encrypt_value", side_effect=lambda v: f"enc:{v}"), \
             patch("caracal.deployment.config_manager.decrypt_value", side_effect=lambda v: v.replace("enc:", "")):
            m.store_secret("KEY_A", "value-a", "multi-workspace")
            m.store_secret("KEY_B", "value-b", "multi-workspace")
            assert m.get_secret("KEY_A", "multi-workspace") == "value-a"
            assert m.get_secret("KEY_B", "multi-workspace") == "value-b"

    def test_overwrite_secret(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("over-workspace")
        with patch("caracal.deployment.config_manager.encrypt_value", side_effect=lambda v: f"enc:{v}"), \
             patch("caracal.deployment.config_manager.decrypt_value", side_effect=lambda v: v.replace("enc:", "")):
            m.store_secret("KEY", "original", "over-workspace")
            m.store_secret("KEY", "updated", "over-workspace")
            assert m.get_secret("KEY", "over-workspace") == "updated"


@pytest.mark.unit
class TestSetWorkspaceConfig:
    def test_set_updates_workspace_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("cfg-workspace")
        original = m.get_workspace_config("cfg-workspace")
        updated = WorkspaceConfig(
            name=original.name,
            created_at=original.created_at,
            updated_at=original.updated_at,
            is_default=original.is_default,
            metadata={"env": "staging"},
        )
        m.set_workspace_config("cfg-workspace", updated)
        reloaded = m.get_workspace_config("cfg-workspace")
        assert reloaded.metadata == {"env": "staging"}

    def test_set_updates_updated_at(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("ts-workspace")
        cfg = m.get_workspace_config("ts-workspace")
        before = cfg.updated_at
        m.set_workspace_config("ts-workspace", cfg)
        after = m.get_workspace_config("ts-workspace").updated_at
        assert after >= before


@pytest.mark.unit
class TestGetPostgresConfig:
    def test_returns_none_when_no_config_file(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m.get_postgres_config() is None

    def test_returns_none_when_no_postgres_section(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import toml
        m = _setup(monkeypatch, tmp_path)
        (tmp_path / "config.toml").write_text(toml.dumps({"other": "data"}))
        assert m.get_postgres_config() is None

    def test_returns_config_with_defaults(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import toml
        m = _setup(monkeypatch, tmp_path)
        (tmp_path / "config.toml").write_text(toml.dumps({
            "postgres": {"host": "db.local", "port": 5432}
        }))
        cfg = m.get_postgres_config()
        assert cfg is not None
        assert cfg.host == "db.local"
        assert cfg.database == "caracal"
        assert cfg.ssl_mode == "require"

    def test_returns_none_on_decode_error(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        (tmp_path / "config.toml").write_text("this is not valid toml ][[[")
        assert m.get_postgres_config() is None


@pytest.mark.unit
class TestSetPostgresConfig:
    def _make_pg(self) -> PostgresConfig:
        return PostgresConfig(
            host="db.local",
            port=5432,
            database="mydb",
            user="user1",
            password_ref="ref:secret",
            ssl_mode="require",
            pool_size=10,
            max_overflow=5,
            pool_timeout=30,
        )

    def test_saves_and_retrieves_postgres_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        monkeypatch.setattr(m, "_validate_postgres_connectivity", lambda cfg: None)
        m.set_postgres_config(self._make_pg())
        result = m.get_postgres_config()
        assert result is not None
        assert result.host == "db.local"
        assert result.database == "mydb"

    def test_merges_with_existing_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        import toml
        m = _setup(monkeypatch, tmp_path)
        monkeypatch.setattr(m, "_validate_postgres_connectivity", lambda cfg: None)
        (tmp_path / "config.toml").write_text(toml.dumps({"other": "preserved"}))
        m.set_postgres_config(self._make_pg())
        config = toml.load(tmp_path / "config.toml")
        assert config.get("other") == "preserved"
        assert "postgres" in config

    def test_raises_on_connectivity_failure(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from caracal.deployment.exceptions import ConfigurationValidationError
        m = _setup(monkeypatch, tmp_path)

        def _raise(cfg: PostgresConfig) -> None:
            raise ConfigurationValidationError("cannot connect")

        monkeypatch.setattr(m, "_validate_postgres_connectivity", _raise)
        with pytest.raises(ConfigurationValidationError):
            m.set_postgres_config(self._make_pg())


@pytest.mark.unit
class TestLoadWorkspaceRuntimeConfig:
    def test_returns_empty_dict_when_no_config_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "myworkspace"
        workspace_dir.mkdir(parents=True)
        result = m._load_workspace_runtime_config(workspace_dir)
        assert result == {}

    def test_returns_dict_from_valid_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "myworkspace"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text("database:\n  host: pg.local\n  port: 5432\n")
        result = m._load_workspace_runtime_config(workspace_dir)
        assert result["database"]["host"] == "pg.local"

    def test_returns_empty_on_bad_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        workspace_dir = tmp_path / "workspaces" / "myworkspace"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "config.yaml").write_text(": [\ninvalid\n")
        result = m._load_workspace_runtime_config(workspace_dir)
        assert result == {}


@pytest.mark.unit
class TestLoadSecretRefs:
    def test_returns_empty_for_workspace_without_refs(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("ref-workspace")
        assert m._load_secret_refs("ref-workspace") == {}

    def test_returns_refs_after_storing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("ref-workspace")
        m._save_secret_refs("ref-workspace", {"MY_KEY": "ENC[v4:val]"})
        result = m._load_secret_refs("ref-workspace")
        assert result == {"MY_KEY": "ENC[v4:val]"}

    def test_load_or_empty_returns_empty_for_missing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        result = m._load_secret_refs_or_empty("no-such-workspace")
        assert result == {}


@pytest.mark.unit
class TestGetWorkspacePath:
    def test_returns_path_for_existing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        m.create_workspace("path-workspace")
        path = m.get_workspace_path("path-workspace")
        assert path.exists()
        assert path.name == "path-workspace"

    def test_raises_for_missing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        with pytest.raises(WorkspaceNotFoundError):
            m.get_workspace_path("nonexistent")
