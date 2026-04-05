"""Hard-cut tests for ConfigManager secret routing."""

from __future__ import annotations

from pathlib import Path

import pytest

from caracal.deployment.config_manager import ConfigManager
import caracal.deployment.config_manager as config_manager_module


def _configure_manager_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ConfigManager, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ConfigManager, "CONFIG_FILE", tmp_path / "config.toml")
    monkeypatch.setattr(ConfigManager, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(ConfigManager, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(ConfigManager, "LOGS_DIR", tmp_path / "logs")


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
