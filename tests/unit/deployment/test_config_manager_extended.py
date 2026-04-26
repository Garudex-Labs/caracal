"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for ConfigManager helper methods and utility functions.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional
from unittest.mock import patch

import pytest
import yaml

from caracal.deployment.config_manager import ConfigManager
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
        assert m._is_workspace_discoverable("my-ws") is True

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
        result = m._legacy_secret_store_path("ws")
        assert result == tmp_path / "workspaces" / "ws" / "secrets.vault"


@pytest.mark.unit
class TestLoadWorkspaceRuntimeConfig:
    def test_returns_empty_when_no_config_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        assert m._load_workspace_runtime_config(ws_dir) == {}

    def test_loads_valid_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        (ws_dir / "config.yaml").write_text(yaml.safe_dump({"key": "value"}))
        result = m._load_workspace_runtime_config(ws_dir)
        assert result == {"key": "value"}

    def test_returns_empty_for_invalid_yaml(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        (ws_dir / "config.yaml").write_text(": bad: yaml:")
        result = m._load_workspace_runtime_config(ws_dir)
        assert result == {}


@pytest.mark.unit
class TestExtractWorkspaceDbConfig:
    def test_returns_none_when_no_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        assert m._extract_workspace_db_config(ws_dir) is None

    def test_returns_none_when_no_schema(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        (ws_dir / "config.yaml").write_text(yaml.safe_dump({"database": {"host": "db"}}))
        assert m._extract_workspace_db_config(ws_dir) is None

    def test_returns_db_config_with_schema(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        ws_dir = tmp_path / "workspaces" / "test"
        ws_dir.mkdir(parents=True)
        (ws_dir / "config.yaml").write_text(
            yaml.safe_dump({"database": {"host": "db", "schema": "myschema", "port": 5432}})
        )
        result = m._extract_workspace_db_config(ws_dir)
        assert result is not None
        assert result["schema"] == "myschema"
        assert result["host"] == "db"


@pytest.mark.unit
class TestPgEnv:
    def test_sets_pgpassword_when_provided(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        env = m._pg_env("my-password")
        assert env["PGPASSWORD"] == "my-password"

    def test_no_pgpassword_when_empty(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        env = m._pg_env("")
        assert "PGPASSWORD" not in env


@pytest.mark.unit
class TestExtractUnsupportedPgSettings:
    def test_extracts_setting_names(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        output = 'pg_restore: error: unrecognized configuration parameter "default_toast_compression"'
        result = m._extract_unsupported_pg_settings(output)
        assert result == ["default_toast_compression"]

    def test_deduplicates_settings(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        output = (
            'unrecognized configuration parameter "foo"\n'
            'unrecognized configuration parameter "foo"\n'
            'unrecognized configuration parameter "bar"\n'
        )
        result = m._extract_unsupported_pg_settings(output)
        assert result == ["foo", "bar"]

    def test_empty_output_returns_empty(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        m = _setup(monkeypatch, tmp_path)
        assert m._extract_unsupported_pg_settings("") == []


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
        m.create_workspace("my-ws")
        assert (m.WORKSPACES_DIR / "my-ws").exists()

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
        m.create_workspace("ws")
        assert m._load_secret_refs("ws") == {}

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
