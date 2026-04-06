"""Unit tests for hard-cut credential migration manager flows."""

from __future__ import annotations

from pathlib import Path

import pytest

from caracal.deployment.config_manager import ConfigManager
import caracal.deployment.enterprise_license as enterprise_license_module
from caracal.deployment.migration import MigrationManager
import caracal.deployment.config_manager as config_manager_module


def _configure_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(ConfigManager, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(ConfigManager, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(MigrationManager, "BACKUP_DIR", tmp_path / "backups")


def _configure_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_manager_module, "encrypt_value", lambda value: f"ENC[v4:{value}]")
    monkeypatch.setattr(
        config_manager_module,
        "decrypt_value",
        lambda value: value.removeprefix("ENC[v4:").removesuffix("]"),
    )


@pytest.mark.unit
def test_oss_to_enterprise_migration_updates_custody_metadata_additively(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_paths(monkeypatch, tmp_path)
    _configure_crypto(monkeypatch)

    cfg = ConfigManager()
    cfg.create_workspace("alpha")
    cfg.store_secret("provider_api_key", "secret-value", "alpha")

    manager = MigrationManager()
    result = manager.migrate_credentials_oss_to_enterprise(
        gateway_url="https://enterprise.example.com",
        workspace="alpha",
        include_credentials=["provider_api_key"],
    )

    updated = cfg.get_workspace_config("alpha")
    custody = updated.metadata[MigrationManager.CREDENTIAL_CUSTODY_METADATA_KEY]["provider_api_key"]

    assert custody["location"] == "enterprise"
    assert custody["additive"] is True
    assert "provider_api_key" in cfg._load_vault("alpha")
    assert result["credentials_selected"] == 1
    assert result["migration_contracts"]["alpha"]["registration_state"]["migration_mode"] == "explicit_only"
    assert result["migration_contracts"]["alpha"]["authority_graph_state"]["graph_model"] == "delegation_edges"
    assert result["migration_contracts"]["alpha"]["vault_references"]["gateway_url"] == "https://enterprise.example.com"


@pytest.mark.unit
def test_enterprise_to_oss_import_stores_local_secret_and_updates_custody(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_paths(monkeypatch, tmp_path)
    _configure_crypto(monkeypatch)

    cfg = ConfigManager()
    cfg.create_workspace("alpha")

    ws_cfg = cfg.get_workspace_config("alpha")
    ws_cfg.metadata[MigrationManager.CREDENTIAL_CUSTODY_METADATA_KEY] = {
        "provider_api_key": {"location": "enterprise"}
    }
    cfg.set_workspace_config("alpha", ws_cfg)

    manager = MigrationManager()
    result = manager.migrate_credentials_enterprise_to_oss(
        workspace="alpha",
        include_credentials=["provider_api_key"],
        exported_credentials={"provider_api_key": "recovered-secret"},
    )

    assert cfg.get_secret("provider_api_key", "alpha") == "recovered-secret"

    updated = cfg.get_workspace_config("alpha")
    custody = updated.metadata[MigrationManager.CREDENTIAL_CUSTODY_METADATA_KEY]["provider_api_key"]
    assert custody["location"] == "local"
    assert result["credentials_imported"] == 1


@pytest.mark.unit
def test_enterprise_to_oss_import_can_apply_explicit_migration_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_paths(monkeypatch, tmp_path)
    _configure_crypto(monkeypatch)

    cfg = ConfigManager()
    cfg.create_workspace("alpha")

    ws_cfg = cfg.get_workspace_config("alpha")
    ws_cfg.metadata[MigrationManager.CREDENTIAL_CUSTODY_METADATA_KEY] = {
        "provider_api_key": {"location": "enterprise"}
    }
    cfg.set_workspace_config("alpha", ws_cfg)

    contract = {
        "version": MigrationManager.MIGRATION_CONTRACT_VERSION,
        "direction": "oss_to_enterprise",
        "source_model": "broker",
        "target_model": "gateway",
        "registration_state": {"registration_state": "configured", "migration_mode": "explicit_only"},
        "authority_graph_state": {"graph_model": "delegation_edges", "root_authority_ready": True},
        "runtime_session_state": {"lifecycle_model": "explicit_session_bootstrap"},
        "vault_references": {"secret_refs": {"runtime_signing_key": "vault://enterprise/provider"}},
    }

    manager = MigrationManager()
    manager.migrate_credentials_enterprise_to_oss(
        workspace="alpha",
        include_credentials=["provider_api_key"],
        exported_credentials={"provider_api_key": "recovered-secret"},
        migration_contract=contract,
    )

    updated = cfg.get_workspace_config("alpha")
    assert updated.metadata[MigrationManager.REGISTRATION_STATE_METADATA_KEY]["registration_state"] == "configured"
    assert updated.metadata[MigrationManager.AUTHORITY_GRAPH_STATE_METADATA_KEY]["root_authority_ready"] is True
    assert updated.metadata["secret_refs"]["runtime_signing_key"] == "vault://enterprise/provider"


@pytest.mark.unit
def test_enterprise_to_oss_can_deactivate_license(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_paths(monkeypatch, tmp_path)
    _configure_crypto(monkeypatch)

    cfg = ConfigManager()
    cfg.create_workspace("alpha")

    ws_cfg = cfg.get_workspace_config("alpha")
    ws_cfg.metadata[MigrationManager.CREDENTIAL_CUSTODY_METADATA_KEY] = {
        "provider_api_key": {"location": "enterprise"}
    }
    cfg.set_workspace_config("alpha", ws_cfg)

    calls: list[str] = []

    class _FakeValidator:
        def disconnect(self) -> None:
            calls.append("disconnect")

    monkeypatch.setattr(enterprise_license_module, "EnterpriseLicenseValidator", _FakeValidator)

    manager = MigrationManager()
    manager.migrate_credentials_enterprise_to_oss(
        workspace="alpha",
        include_credentials=["provider_api_key"],
        exported_credentials={"provider_api_key": "recovered-secret"},
        deactivate_license=True,
    )

    assert calls == ["disconnect"]
