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
    enterprise_group,
    provider_group,
    workspace_group,
)
from caracal.deployment.config_manager import ConfigManager
from caracal.deployment import Mode


def _setup_config_manager(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setenv("CCL_CFG_DIR", str(tmp_path))


@pytest.mark.unit
class TestResolveLockKey:
    def test_explicit_lock_key_returned(self) -> None:
        result = _resolve_workspace_lock_key("my-lock-key")
        assert result == "my-lock-key"

    def test_env_var_used_when_no_explicit_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CCL_WORKSPACE_LOCK_KEY", "env-lock-key")
        result = _resolve_workspace_lock_key(None)
        assert result == "env-lock-key"

    def test_none_when_no_key_or_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CCL_WORKSPACE_LOCK_KEY", raising=False)
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
            result = self.runner.invoke(workspace_group, ["create", "test-workspace"])
        assert result.exit_code == 0
        assert "created" in result.output.lower() or "test-workspace" in result.output

    def test_workspace_create_json_output(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["create", "--format=json", "json-workspace"])
        assert result.exit_code == 0
        json_line = next(l for l in result.output.splitlines() if l.startswith("{"))
        data = json.loads(json_line)
        assert data["workspace"] == "json-workspace"
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
            self.runner.invoke(workspace_group, ["create", "workspace-one"])
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

    def test_config_edition_shows_current(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from caracal.deployment.edition import Edition
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.cli.deployment_cli.get_deployment_edition_adapter") as mock_get:
            mock_adapter = MagicMock()
            mock_adapter.get_edition.return_value = Edition.OPENSOURCE
            mock_get.return_value = mock_adapter
            result = self.runner.invoke(config_group, ["edition"])
        assert result.exit_code == 0

    def test_config_edition_json(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from caracal.deployment.edition import Edition
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.cli.deployment_cli.get_deployment_edition_adapter") as mock_get:
            mock_adapter = MagicMock()
            mock_adapter.get_edition.return_value = Edition.OPENSOURCE
            mock_get.return_value = mock_adapter
            result = self.runner.invoke(config_group, ["edition", "--format=json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "edition" in data

    def test_config_edition_rejects_manual_set(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        result = self.runner.invoke(config_group, ["edition", "enterprise"])
        assert result.exit_code != 0


@pytest.mark.unit
class TestEnterpriseCommands:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_enterprise_help(self) -> None:
        result = self.runner.invoke(enterprise_group, ["--help"])
        assert result.exit_code == 0

    def test_enterprise_status_no_license(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        result = self.runner.invoke(enterprise_group, ["status"])
        assert result.exit_code in (0, 1)

    def test_enterprise_sync_dry_run(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV, \
             patch("caracal.cli.deployment_cli._require_workspace", return_value="default"), \
             patch("caracal.cli.deployment_cli.ConfigManager"):
            mock_v = MagicMock()
            mock_v.get_license_info.return_value = {"license_active": True}
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["sync", "--dry-run"])
        assert result.exit_code == 0
        assert "dry run" in result.output.lower()

    def test_enterprise_sync_no_license(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV, \
             patch("caracal.cli.deployment_cli._require_workspace", return_value="default"), \
             patch("caracal.cli.deployment_cli.ConfigManager"):
            mock_v = MagicMock()
            mock_v.get_license_info.return_value = {"license_active": False}
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["sync"])
        assert result.exit_code != 0

    def test_enterprise_login_invalid_token(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV:
            mock_v = MagicMock()
            mock_result = MagicMock()
            mock_result.valid = False
            mock_result.message = "Invalid token"
            mock_v.validate_license.return_value = mock_result
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["login", "https://api.example.com", "bad-token"])
        assert result.exit_code != 0
        assert "Invalid token" in result.output

    def test_enterprise_login_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV:
            mock_v = MagicMock()
            mock_result = MagicMock()
            mock_result.valid = True
            mock_result.message = "OK"
            mock_result.enterprise_api_url = "https://api.example.com"
            mock_result.tier = "enterprise"
            mock_v.validate_license.return_value = mock_result
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["login", "https://api.example.com", "good-token"])
        assert result.exit_code == 0
        assert "enterprise" in result.output.lower()

    def test_enterprise_status_with_license(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV, \
             patch("caracal.cli.deployment_cli._require_workspace", return_value="default"), \
             patch("caracal.cli.deployment_cli.ConfigManager"):
            mock_v = MagicMock()
            mock_v.get_license_info.return_value = {"license_active": True, "tier": "pro"}
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["status"])
        assert result.exit_code == 0

    def test_enterprise_status_json(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with patch("caracal.deployment.enterprise_license.EnterpriseLicenseValidator") as MockV, \
             patch("caracal.cli.deployment_cli._require_workspace", return_value="default"), \
             patch("caracal.cli.deployment_cli.ConfigManager"):
            mock_v = MagicMock()
            mock_v.get_license_info.return_value = {"license_active": True, "tier": "pro"}
            MockV.return_value = mock_v
            result = self.runner.invoke(enterprise_group, ["status", "--format=json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["license_active"] is True


@pytest.mark.unit
class TestConfigSetGetList:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_config_set_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "myworkspace"])
        mock_cm = MagicMock()
        mock_cm.get_default_workspace_name.return_value = "myworkspace"
        mock_cm.list_workspaces.return_value = ["myworkspace"]
        with patch("caracal.cli.deployment_cli.ConfigManager", return_value=mock_cm):
            result = self.runner.invoke(config_group, ["set", "MY_KEY", "myvalue"])
        assert result.exit_code == 0
        assert "MY_KEY" in result.output

    def test_config_get_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        mock_cm = MagicMock()
        mock_cm.get_default_workspace_name.return_value = "myworkspace"
        mock_cm.list_workspaces.return_value = ["myworkspace"]
        mock_cm.get_secret.return_value = "secretvalue"
        with patch("caracal.cli.deployment_cli.ConfigManager", return_value=mock_cm):
            result = self.runner.invoke(config_group, ["get", "MY_KEY"])
        assert result.exit_code == 0
        assert "secretvalue" in result.output

    def test_config_get_json(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        mock_cm = MagicMock()
        mock_cm.get_default_workspace_name.return_value = "myworkspace"
        mock_cm.list_workspaces.return_value = ["myworkspace"]
        mock_cm.get_secret.return_value = "secretvalue"
        with patch("caracal.cli.deployment_cli.ConfigManager", return_value=mock_cm):
            result = self.runner.invoke(config_group, ["get", "--format=json", "MY_KEY"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["MY_KEY"] == "secretvalue"

    def test_config_list_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        mock_cm = MagicMock()
        mock_cm.get_default_workspace_name.return_value = "myworkspace"
        mock_cm.list_workspaces.return_value = ["myworkspace"]
        mock_cm._load_secret_refs_or_empty.return_value = {"KEY1": "ref1", "KEY2": "ref2"}
        with patch("caracal.cli.deployment_cli.ConfigManager", return_value=mock_cm):
            result = self.runner.invoke(config_group, ["list"])
        assert result.exit_code == 0
        assert "KEY1" in result.output

    def test_config_list_json(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        mock_cm = MagicMock()
        mock_cm.get_default_workspace_name.return_value = "myworkspace"
        mock_cm.list_workspaces.return_value = ["myworkspace"]
        mock_cm._load_secret_refs_or_empty.return_value = {"KEY1": "ref1"}
        with patch("caracal.cli.deployment_cli.ConfigManager", return_value=mock_cm):
            result = self.runner.invoke(config_group, ["list", "--format=json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "keys" in data
        assert "KEY1" in data["keys"]


@pytest.mark.unit
class TestWorkspaceDeleteExportImport:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def test_workspace_delete_force(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "to-delete"])
            result = self.runner.invoke(workspace_group, ["delete", "--force", "to-delete"])
        assert result.exit_code == 0
        assert "deleted" in result.output.lower()

    def test_workspace_delete_not_found(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["delete", "--force", "ghost"])
        assert result.exit_code != 0

    def test_workspace_delete_cancel(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "keep-workspace"])
            result = self.runner.invoke(workspace_group, ["delete", "keep-workspace"], input="n\n")
        assert "Cancelled" in result.output or result.exit_code == 0

    def test_workspace_export_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        export_path = tmp_path / "export.tar.gz"
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "export-workspace"])
            result = self.runner.invoke(workspace_group, ["export", "export-workspace", str(export_path)])
        assert result.exit_code == 0
        assert "exported" in result.output.lower()

    def test_workspace_export_with_lock_key(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        export_path = tmp_path / "locked.tar.gz"
        with self.runner.isolated_filesystem():
            self.runner.invoke(workspace_group, ["create", "lockws"])
            result = self.runner.invoke(
                workspace_group,
                ["export", "lockws", str(export_path), "--lock-key", "my-secure-key-123"],
            )
        assert result.exit_code == 0
        assert "Locked" in result.output

    def test_workspace_import_missing_file(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        _setup_config_manager(monkeypatch, tmp_path)
        missing_path = tmp_path / "nonexistent.tar.gz"
        with self.runner.isolated_filesystem():
            result = self.runner.invoke(workspace_group, ["import", str(missing_path)])
        assert result.exit_code != 0


@pytest.mark.unit
class TestProviderGroupCommands:
    def setup_method(self) -> None:
        self.runner = CliRunner()

    def _make_env(self, monkeypatch: pytest.MonkeyPatch, registry: dict | None = None):
        from caracal import cli as deployment_cli_module
        from caracal.cli import deployment_cli as dcli
        import copy

        reg = registry or {}

        class _FakeCM:
            def get_default_workspace_name(self):
                return "default"
            def list_workspaces(self):
                return ["default"]

        class _FakeAdapter:
            def uses_gateway_execution(self):
                return False

        monkeypatch.setattr(dcli, "ConfigManager", _FakeCM)
        monkeypatch.setattr(dcli, "get_deployment_edition_adapter", lambda: _FakeAdapter())
        monkeypatch.setattr(dcli, "load_workspace_provider_registry", lambda _cm, _workspace: copy.deepcopy(reg))

        def _save(cm, workspace, providers):
            reg.clear()
            reg.update(copy.deepcopy(providers))

        monkeypatch.setattr(dcli, "save_workspace_provider_registry", _save)
        monkeypatch.setattr(
            dcli,
            "sync_workspace_provider_registry_runtime",
            lambda **kw: {"impacted": []},
        )
        monkeypatch.setattr(
            dcli,
            "delete_workspace_provider_credential",
            lambda workspace, ref: None,
        )
        monkeypatch.setattr(
            dcli,
            "list_tool_bindings_by_provider",
            lambda db_session: {},
        )
        return reg

    def test_provider_list_empty(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        from caracal.cli import deployment_cli as dcli
        self._make_env(monkeypatch)
        result = self.runner.invoke(provider_group, ["list"])
        assert result.exit_code == 0

    def test_provider_list_with_entries(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        from caracal.cli import deployment_cli as dcli
        from caracal.provider.catalog import build_provider_record
        reg = {"myprovider": build_provider_record(
            name="myprovider",
            service_type="ai",
            definition_id="myprovider",
            auth_scheme="bearer",
            base_url="https://api.example.com",
            definition=None,
            credential_ref="ref1",
        )}
        self._make_env(monkeypatch, registry=reg)
        result = self.runner.invoke(provider_group, ["list"])
        assert result.exit_code == 0

    def test_provider_list_json(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        from caracal.cli import deployment_cli as dcli
        self._make_env(monkeypatch)
        result = self.runner.invoke(provider_group, ["list", "--format=json"])
        assert result.exit_code == 0
        json_line = next(l for l in result.output.splitlines() if l.startswith("{"))
        data = json.loads(json_line)
        assert "providers" in data

    def test_provider_remove_not_found(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        self._make_env(monkeypatch)
        result = self.runner.invoke(provider_group, ["remove", "--force", "ghost"])
        assert result.exit_code != 0

    def test_provider_remove_success(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        from caracal.provider.catalog import build_provider_record
        reg = {"myprovider": build_provider_record(
            name="myprovider",
            service_type="ai",
            definition_id="myprovider",
            auth_scheme="none",
            base_url="https://api.example.com",
            definition=None,
        )}
        self._make_env(monkeypatch, registry=reg)
        result = self.runner.invoke(provider_group, ["remove", "--force", "myprovider"])
        assert result.exit_code == 0
        assert "removed" in result.output.lower()

    def test_provider_help(self) -> None:
        result = self.runner.invoke(provider_group, ["--help"])
        assert result.exit_code == 0
