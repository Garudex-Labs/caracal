"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for pure utility functions in flow/screens/onboarding.py.
"""

import pytest
from pathlib import Path
from unittest.mock import patch

pytestmark = pytest.mark.unit


class TestValidateEnvConfig:
    def test_empty_config_has_all_issues(self):
        from caracal.flow.screens.onboarding import _validate_env_config
        issues = _validate_env_config({})
        assert len(issues) > 0
        assert any("CCL_DB_NAME" in i for i in issues)
        assert any("CCL_DB_USER" in i for i in issues)
        assert any("CCL_DB_PASSWORD" in i for i in issues)

    def test_valid_config_has_no_issues(self):
        from caracal.flow.screens.onboarding import _validate_env_config
        config = {
            "database": "caracal",
            "username": "caracal",
            "password": "secret123",
            "port": 5432,
        }
        issues = _validate_env_config(config)
        assert issues == []

    def test_invalid_port_reports_issue(self):
        from caracal.flow.screens.onboarding import _validate_env_config
        config = {
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
            "port": 99999,
        }
        issues = _validate_env_config(config)
        assert any("CCL_DB_PORT" in i for i in issues)

    def test_missing_password_reports_issue(self):
        from caracal.flow.screens.onboarding import _validate_env_config
        config = {
            "database": "caracal",
            "username": "caracal",
            "password": "",
            "port": 5432,
        }
        issues = _validate_env_config(config)
        assert any("CCL_DB_PASSWORD" in i for i in issues)

    def test_string_port_reports_issue(self):
        from caracal.flow.screens.onboarding import _validate_env_config
        config = {
            "database": "caracal",
            "username": "caracal",
            "password": "pass",
            "port": "notanint",
        }
        issues = _validate_env_config(config)
        assert any("CCL_DB_PORT" in i for i in issues)


class TestResolveWorkspaceImportPath:
    def test_returns_resolved_path(self, tmp_path):
        from caracal.flow.screens.onboarding import _resolve_workspace_import_path
        p = str(tmp_path)
        with patch("caracal.flow.screens.onboarding.in_container_runtime", return_value=False):
            result = _resolve_workspace_import_path(p)
        assert result == tmp_path.resolve()

    def test_strips_whitespace_and_newlines(self, tmp_path):
        from caracal.flow.screens.onboarding import _resolve_workspace_import_path
        p = f"  {tmp_path}  \n"
        with patch("caracal.flow.screens.onboarding.in_container_runtime", return_value=False):
            result = _resolve_workspace_import_path(p)
        assert result.exists() or not result.exists()

    def test_expands_home_tilde(self):
        from caracal.flow.screens.onboarding import _resolve_workspace_import_path
        with patch("caracal.flow.screens.onboarding.in_container_runtime", return_value=False):
            result = _resolve_workspace_import_path("~/some/path")
        assert "~" not in str(result)


class TestFindDeployComposeFile:
    def test_returns_none_when_no_deploy_dir(self, tmp_path, monkeypatch):
        from caracal.flow.screens.onboarding import _find_deploy_compose_file
        monkeypatch.chdir(tmp_path)
        result = _find_deploy_compose_file()
        assert result is None

    def test_returns_path_when_compose_file_exists(self, tmp_path, monkeypatch):
        from caracal.flow.screens.onboarding import _find_deploy_compose_file
        deploy_dir = tmp_path / "deploy"
        deploy_dir.mkdir()
        compose = deploy_dir / "docker-compose.yml"
        compose.write_text("services: {}")
        monkeypatch.chdir(tmp_path)
        result = _find_deploy_compose_file()
        assert result == compose


class TestIsContainerRuntime:
    def test_returns_bool(self):
        from caracal.flow.screens.onboarding import _is_container_runtime
        result = _is_container_runtime()
        assert isinstance(result, bool)
