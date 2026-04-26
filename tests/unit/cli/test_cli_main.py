"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for cli/main.py pure helper functions and Click group classes.
"""
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

import click
from click.testing import CliRunner

from caracal.cli.main import (
    format_workspace_status,
    get_active_workspace,
    get_workspace_config_path,
    SuggestingGroup,
    WorkspaceAwareGroup,
)


@pytest.mark.unit
class TestFormatWorkspaceStatus:
    def test_with_active_workspace(self):
        result = format_workspace_status("my-workspace")
        assert "my-workspace" in result

    def test_with_none_shows_warning(self):
        result = format_workspace_status(None)
        assert "WARNING" in result or "No workspace" in result

    def test_with_empty_string_shows_warning(self):
        result = format_workspace_status("")
        assert "WARNING" in result or "No workspace" in result

    def test_truthy_workspace_no_warning(self):
        result = format_workspace_status("prod")
        assert "WARNING" not in result


@pytest.mark.unit
class TestGetActiveWorkspace:
    def test_returns_none_on_exception(self):
        with patch("caracal.deployment.config_manager.ConfigManager", side_effect=ImportError):
            result = get_active_workspace()
        assert result is None

    def test_returns_workspace_name(self):
        mock_mgr = MagicMock()
        mock_mgr.get_default_workspace_name.return_value = "default"
        with patch("caracal.deployment.config_manager.ConfigManager", return_value=mock_mgr):
            result = get_active_workspace()
        assert result == "default"

    def test_returns_none_when_config_raises(self):
        mock_mgr = MagicMock()
        mock_mgr.get_default_workspace_name.side_effect = RuntimeError("db error")
        with patch("caracal.deployment.config_manager.ConfigManager", return_value=mock_mgr):
            result = get_active_workspace()
        assert result is None


@pytest.mark.unit
class TestGetWorkspaceConfigPath:
    def test_none_workspace_returns_none(self):
        assert get_workspace_config_path(None) is None

    def test_empty_workspace_returns_none(self):
        assert get_workspace_config_path("") is None

    def test_returns_config_yaml_path(self, tmp_path):
        mock_mgr = MagicMock()
        mock_mgr.get_workspace_path.return_value = tmp_path
        with patch("caracal.deployment.config_manager.ConfigManager", return_value=mock_mgr):
            result = get_workspace_config_path("dev")
        assert result == tmp_path / "config.yaml"

    def test_exception_returns_none(self):
        mock_mgr = MagicMock()
        mock_mgr.get_workspace_path.side_effect = Exception("not found")
        with patch("caracal.deployment.config_manager.ConfigManager", return_value=mock_mgr):
            result = get_workspace_config_path("dev")
        assert result is None


@pytest.mark.unit
class TestSuggestingGroup:
    def _make_group(self):
        @click.group(cls=SuggestingGroup)
        def grp():
            pass

        @grp.command()
        def status():
            pass

        @grp.command()
        def start():
            pass

        return grp

    def test_known_command_resolves(self):
        runner = CliRunner()
        grp = self._make_group()
        result = runner.invoke(grp, ["status"])
        assert result.exit_code == 0

    def test_unknown_command_suggests_close_match(self):
        runner = CliRunner()
        grp = self._make_group()
        result = runner.invoke(grp, ["statu"])
        assert "statu" in result.output or "status" in result.output

    def test_typo_with_no_close_match_gives_hint(self):
        runner = CliRunner()
        grp = self._make_group()
        result = runner.invoke(grp, ["zzzunknown"])
        assert "zzzunknown" in result.output or "not found" in result.output.lower()

    def test_suggest_command_returns_match(self):
        grp = self._make_group()
        ctx = click.Context(grp)
        suggestion = grp._suggest_command(ctx, "statu")
        assert suggestion == "status"

    def test_suggest_command_returns_none_for_garbage(self):
        grp = self._make_group()
        ctx = click.Context(grp)
        suggestion = grp._suggest_command(ctx, "zzzzz")
        assert suggestion is None
