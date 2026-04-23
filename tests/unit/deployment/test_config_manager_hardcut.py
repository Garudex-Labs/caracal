"""Hard-cut tests for ConfigManager secret routing."""

from __future__ import annotations

from pathlib import Path

import pytest

from caracal.deployment.config_manager import ConfigManager
import caracal.deployment.config_manager as config_manager_module
import caracal.flow.workspace as flow_workspace


def _configure_manager_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")


@pytest.mark.unit
def test_store_secret_persists_vault_reference_in_workspace_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(config_manager_module, "encrypt_value", lambda value: f"ENC[v4:{value}]")

    manager = ConfigManager()
    manager.create_workspace("alpha")
    manager.store_secret("gateway_token", "secret-value", "alpha")

    config = manager._load_workspace_toml("alpha")
    metadata = config.get("metadata", {})

    assert metadata["secret_refs"]["gateway_token"] == "ENC[v4:secret-value]"
    assert not manager._legacy_secret_store_path("alpha").exists()


@pytest.mark.unit
def test_get_secret_resolves_vault_reference_from_workspace_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(config_manager_module, "encrypt_value", lambda value: f"ENC[v4:{value}]")
    monkeypatch.setattr(
        config_manager_module,
        "decrypt_value",
        lambda value: value.removeprefix("ENC[v4:").removesuffix("]"),
    )

    manager = ConfigManager()
    manager.create_workspace("alpha")
    manager.store_secret("gateway_token", "secret-value", "alpha")

    assert manager.get_secret("gateway_token", "alpha") == "secret-value"


@pytest.mark.unit
def test_save_vault_compatibility_shim_updates_secret_refs_without_local_secret_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)

    manager = ConfigManager()
    manager.create_workspace("alpha")
    manager._save_vault("alpha", {"provider_api_key": "ENC[v4:vault://default/dev/provider]"})

    config = manager._load_workspace_toml("alpha")
    metadata = config.get("metadata", {})

    assert metadata["secret_refs"] == {"provider_api_key": "ENC[v4:vault://default/dev/provider]"}
    assert not manager._legacy_secret_store_path("alpha").exists()


@pytest.mark.unit
def test_workspace_config_write_does_not_emit_legacy_sync_fields(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)

    manager = ConfigManager()
    manager.create_workspace("alpha", template="enterprise")

    config = manager._load_workspace_toml("alpha")

    assert "sync_enabled" not in config
    assert "sync_url" not in config
    assert "sync_direction" not in config
    assert "auto_sync_interval" not in config
    assert "last_sync" not in config
    assert "conflict_strategy" not in config


@pytest.mark.unit
def test_legacy_sync_fields_load_and_are_removed_on_next_save(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)

    manager = ConfigManager()
    manager.create_workspace("alpha")

    legacy = manager._load_workspace_toml("alpha")
    legacy.update(
        {
            "sync_enabled": True,
            "sync_url": "https://enterprise.example",
            "sync_direction": "bidirectional",
            "auto_sync_interval": 300,
            "last_sync": "2026-01-01T00:00:00",
            "conflict_strategy": "operational_transform",
        }
    )
    manager._save_workspace_toml("alpha", legacy)

    cfg = manager.get_workspace_config("alpha")
    assert cfg.name == "alpha"
    assert cfg.is_default is True

    manager.set_workspace_config("alpha", cfg)
    cleaned = manager._load_workspace_toml("alpha")

    assert "sync_enabled" not in cleaned
    assert "sync_url" not in cleaned
    assert "sync_direction" not in cleaned
    assert "auto_sync_interval" not in cleaned
    assert "last_sync" not in cleaned
    assert "conflict_strategy" not in cleaned


@pytest.mark.unit
def test_delete_workspace_clears_cached_flow_workspace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_manager_paths(monkeypatch, tmp_path)

    manager = ConfigManager()
    manager.create_workspace("alpha")
    workspace_path = manager.get_workspace_path("alpha")

    flow_workspace.set_workspace(workspace_path)
    assert flow_workspace.get_workspace().root == workspace_path

    manager.delete_workspace("alpha", backup=False)

    assert flow_workspace._current_workspace is None
    assert manager.list_workspaces() == []
