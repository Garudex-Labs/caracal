"""Hard-cut validation tests for configuration loading."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from caracal.config.settings import (
    CaracalConfig,
    InvalidConfigurationError,
    MerkleConfig,
    StorageConfig,
    _validate_config,
    load_config,
)


def _base_config() -> CaracalConfig:
    return CaracalConfig(storage=StorageConfig(backup_dir="/tmp/caracal-test-backups"))


@pytest.mark.unit
def test_validate_config_rejects_software_merkle_backend_in_hardcut() -> None:
    config = _base_config()
    config.merkle = MerkleConfig(
        signing_backend="software",
        private_key_path="/tmp/merkle_signing_key.pem",
    )

    with pytest.raises(InvalidConfigurationError, match="must be 'vault'"):
        _validate_config(config)


@pytest.mark.unit
def test_validate_config_requires_vault_merkle_refs_in_hardcut() -> None:
    config = _base_config()
    config.merkle = MerkleConfig(signing_backend="vault")

    with pytest.raises(InvalidConfigurationError, match="vault_key_ref"):
        _validate_config(config)


@pytest.mark.unit
def test_validate_config_accepts_vault_merkle_refs_in_hardcut() -> None:
    config = _base_config()
    config.merkle = MerkleConfig(
        signing_backend="vault",
        vault_key_ref="vault://caracal/runtime/merkle-signing",
        vault_public_key_ref="vault://caracal/runtime/merkle-signing.public",
    )

    _validate_config(config)


@pytest.mark.unit
def test_load_config_normalizes_legacy_merkle_backend_for_hardcut(tmp_path: Path) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        yaml.safe_dump(
            {
                "storage": {"backup_dir": str(tmp_path / "backups"), "backup_count": 3},
                "defaults": {"time_window": "daily"},
                "logging": {"level": "INFO", "file": str(tmp_path / "logs" / "caracal.log")},
                "redis": {"host": "localhost", "port": 6379, "db": 0},
                "merkle": {
                    "signing_backend": "software",
                    "signing_algorithm": "ES256",
                    "private_key_path": str(tmp_path / "keys" / "merkle.pem"),
                },
            },
            default_flow_style=False,
            sort_keys=False,
        )
    )

    with patch.dict(
        os.environ,
        {
            "CCL_VAULT_MERKLE_SIGNING_KEY_REF": "vault://caracal/runtime/merkle-signing",
            "CCL_VAULT_MERKLE_PUBLIC_KEY_REF": "vault://caracal/runtime/merkle-signing.public",
        },
        clear=False,
    ):
        loaded = load_config(str(cfg), emit_logs=False)

    assert loaded.merkle.signing_backend == "vault"
    assert loaded.merkle.vault_key_ref == "vault://caracal/runtime/merkle-signing"
    assert loaded.merkle.vault_public_key_ref == "vault://caracal/runtime/merkle-signing.public"

    persisted = yaml.safe_load(cfg.read_text())
    assert persisted["merkle"]["signing_backend"] == "vault"
    assert "private_key_path" not in persisted["merkle"]
