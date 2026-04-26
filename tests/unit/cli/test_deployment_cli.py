"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for deployment CLI helper functions and commands.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from caracal.cli.deployment_cli import (
    _resolve_workspace_lock_key,
    config_group,
    workspace_group,
)
from caracal.deployment.config_manager import ConfigManager
from caracal.deployment import Mode


def _setup_config_manager(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setenv("CCL_CONFIG_DIR", str(tmp_path))


@pytest.mark.unit
class TestResolveLockKey:
    def test_explicit_lock_key_returned(self) -> None:
        result = _resolve_workspace_lock_key("my-lock-key")
        assert result == "my-lock-key"

    def test_env_var_used_when_no_explicit_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CCL_WS_LOCK_KEY", "env-lock-key")
        result = _resolve_workspace_lock_key(None)
        assert result == "env-lock-key"

    def test_none_when_no_key_or_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CCL_WS_LOCK_KEY", raising=False)
        result = _resolve_workspace_lock_key(None)
        assert result is None


@pytest.mark.unit
class TestWorkspaceCommands:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_workspace_create_success(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["create", "test-ws"])
        assert result.exit_code == 0
        assert "created" in result.output.lower() or "test-ws" in result.output

    def test_workspace_create_json_output(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["create", "--format=json", "json-ws"])
        assert result.exit_code == 0
        json_line = next(l for l in result.output.splitlines() if l.startswith("{"))
        data = json.loads(json_line)
        assert data["workspace"] == "json-ws"
        assert data["status"] == "created"

    def test_workspace_list_empty(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["list"])
        assert result.exit_code == 0
        assert "No workspaces" in result.output

    def test_workspace_list_with_workspaces(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "ws-one"])
            result = self.runner.invoke(workspace_group, ["list"])
        assert result.exit_code == 0

    def test_workspace_list_json(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "alpha"])
            result = self.runner.invoke(workspace_group, ["list", "--format=json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "workspaces" in data

    def test_workspace_switch_success(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "target"])
            result = self.runner.invoke(workspace_group, ["switch", "target"])
        assert result.exit_code == 0
        assert "target" in result.output

    def test_workspace_switch_missing_workspace(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["switch", "nonexistent"])
        assert result.exit_code != 0

    def test_workspace_help(self) -> None:
        result = self.runner.invoke(workspace_group, ["--help"])
        assert result.exit_code == 0


@pytest.mark.unit
class TestConfigCommands:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_config_mode_shows_current(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.cli.deployment_cli.ModeManager") as MockMM:
            mock_mm = MagicMock()
            mock_mm.get_mode.return_value = Mode.DEVELOPMENT
            MockMM.return_value = mock_mm
            result = self.runner.invoke(config_group, ["mode"])
        assert result.exit_code == 0

    def test_config_mode_json_output(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.cli.deployment_cli.ModeManager") as MockMM:
            mock_mm = MagicMock()
            mock_mm.get_mode.return_value = Mode.USER
            MockMM.return_value = mock_mm
            result = self.runner.invoke(config_group, ["mode", "--format=json"])
        assert result.exit_code == 0

    def test_config_help(self) -> None:
        result = self.runner.invoke(config_group, ["--help"])
        assert result.exit_code == 0
