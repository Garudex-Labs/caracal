"""Unit tests for explicit hard-cut migration CLI commands."""

from __future__ import annotations

import json

from click.testing import CliRunner
import pytest

import caracal.cli.migration as migration_cli
from caracal.cli.migration import migrate_group


@pytest.mark.unit
def test_oss_to_enterprise_command_uses_selected_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {}

    class _FakeManager:
        def migrate_credentials_oss_to_enterprise(self, **kwargs):
            calls.update(kwargs)
            return {
                "workspaces": ["alpha"],
                "credentials_selected": 2,
                "dry_run": False,
                "decisions": [],
            }

    monkeypatch.setattr(
        migration_cli,
        "_enforce_explicit_hardcut_migration_policy",
        lambda: None,
    )
    monkeypatch.setattr(migration_cli, "MigrationManager", lambda: _FakeManager())

    runner = CliRunner()
    result = runner.invoke(
        migrate_group,
        [
            "oss-to-enterprise",
            "--gateway-url",
            "https://enterprise.example.com",
            "--migrate-credential",
            "cred_one",
            "--migrate-credential",
            "cred_two",
        ],
    )

    assert result.exit_code == 0
    assert calls["include_credentials"] == ["cred_one", "cred_two"]


@pytest.mark.unit
def test_oss_to_enterprise_command_can_write_contract_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    class _FakeManager:
        def migrate_credentials_oss_to_enterprise(self, **_kwargs):
            return {
                "workspaces": ["alpha"],
                "credentials_selected": 1,
                "dry_run": False,
                "decisions": [],
                "migration_contracts": {"alpha": {"direction": "oss_to_enterprise"}},
            }

    monkeypatch.setattr(
        migration_cli,
        "_enforce_explicit_hardcut_migration_policy",
        lambda: None,
    )
    monkeypatch.setattr(migration_cli, "MigrationManager", lambda: _FakeManager())

    contract_path = tmp_path / "contract.json"

    runner = CliRunner()
    result = runner.invoke(
        migrate_group,
        [
            "oss-to-enterprise",
            "--gateway-url",
            "https://enterprise.example.com",
            "--write-contract-file",
            str(contract_path),
        ],
    )

    assert result.exit_code == 0
    assert json.loads(contract_path.read_text(encoding="utf-8"))["migration_contracts"]["alpha"]["direction"] == "oss_to_enterprise"


@pytest.mark.unit
def test_enterprise_to_oss_command_parses_import_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {}

    class _FakeManager:
        def migrate_credentials_enterprise_to_oss(self, **kwargs):
            calls.update(kwargs)
            return {
                "workspaces": ["alpha"],
                "credentials_selected": 1,
                "credentials_imported": 1,
                "license_deactivated": False,
                "dry_run": False,
                "decisions": [],
            }

    monkeypatch.setattr(
        migration_cli,
        "_enforce_explicit_hardcut_migration_policy",
        lambda: None,
    )
    monkeypatch.setattr(migration_cli, "MigrationManager", lambda: _FakeManager())

    runner = CliRunner()
    result = runner.invoke(
        migrate_group,
        [
            "enterprise-to-oss",
            "--migrate-credential",
            "provider_api_key",
            "--import-credential",
            "provider_api_key=secret-123",
        ],
    )

    assert result.exit_code == 0
    assert calls["include_credentials"] == ["provider_api_key"]
    assert calls["exported_credentials"] == {"provider_api_key": "secret-123"}


@pytest.mark.unit
def test_enterprise_to_oss_command_can_read_contract_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    calls = {}

    class _FakeManager:
        def migrate_credentials_enterprise_to_oss(self, **kwargs):
            calls.update(kwargs)
            return {
                "workspaces": ["alpha"],
                "credentials_selected": 1,
                "credentials_imported": 1,
                "license_deactivated": False,
                "dry_run": False,
                "decisions": [],
                "migration_contracts": {"alpha": {"direction": "enterprise_to_oss"}},
            }

    monkeypatch.setattr(
        migration_cli,
        "_enforce_explicit_hardcut_migration_policy",
        lambda: None,
    )
    monkeypatch.setattr(migration_cli, "MigrationManager", lambda: _FakeManager())

    contract_path = tmp_path / "contract.json"
    contract_path.write_text(
        json.dumps({"version": "v1", "direction": "oss_to_enterprise", "registration_state": {}}),
        encoding="utf-8",
    )

    runner = CliRunner()
    result = runner.invoke(
        migrate_group,
        [
            "enterprise-to-oss",
            "--workspace",
            "alpha",
            "--migrate-credential",
            "provider_api_key",
            "--import-contract-file",
            str(contract_path),
        ],
    )

    assert result.exit_code == 0
    assert calls["migration_contract"]["direction"] == "oss_to_enterprise"
