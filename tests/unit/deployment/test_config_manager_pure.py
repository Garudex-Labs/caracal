"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for ConfigManager pure methods and data models.
"""

import pytest
import base64
import os
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

from caracal.deployment.config_manager import (
    SyncDirection,
    ConflictStrategy,
    WorkspaceConfig,
    PostgresConfig,
    ConfigManager,
)
from caracal.deployment.exceptions import (
    InvalidWorkspaceNameError,
    WorkspaceOperationError,
)


pytestmark = pytest.mark.unit


class TestSyncDirection:
    def test_push_value(self):
        assert SyncDirection.PUSH.value == "push"

    def test_pull_value(self):
        assert SyncDirection.PULL.value == "pull"

    def test_bidirectional_value(self):
        assert SyncDirection.BIDIRECTIONAL.value == "bidirectional"

    def test_from_string(self):
        assert SyncDirection("push") == SyncDirection.PUSH


class TestConflictStrategy:
    def test_operational_transform_value(self):
        assert ConflictStrategy.OPERATIONAL_TRANSFORM.value == "operational_transform"

    def test_last_write_wins_value(self):
        assert ConflictStrategy.LAST_WRITE_WINS.value == "last_write_wins"

    def test_remote_wins_value(self):
        assert ConflictStrategy.REMOTE_WINS.value == "remote_wins"

    def test_local_wins_value(self):
        assert ConflictStrategy.LOCAL_WINS.value == "local_wins"

    def test_manual_value(self):
        assert ConflictStrategy.MANUAL.value == "manual"


class TestWorkspaceConfig:
    def test_dataclass_fields(self):
        cfg = WorkspaceConfig(
            name="test",
            created_at=datetime(2026, 1, 1),
            updated_at=datetime(2026, 1, 2),
            is_default=True,
            metadata={"k": "v"},
        )
        assert cfg.name == "test"
        assert cfg.is_default is True
        assert cfg.metadata == {"k": "v"}


class TestPostgresConfig:
    def test_dataclass_fields(self):
        cfg = PostgresConfig(
            host="localhost",
            port=5432,
            database="caracal",
            user="user1",
            password_ref="ref:secret",
            ssl_mode="require",
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
        )
        assert cfg.host == "localhost"
        assert cfg.port == 5432
        assert cfg.ssl_mode == "require"


def _make_manager(tmp_path: Path) -> ConfigManager:
    mgr = ConfigManager.__new__(ConfigManager)
    mgr.CONFIG_DIR = tmp_path
    mgr.CONFIG_FILE = tmp_path / "config.toml"
    mgr.WORKSPACES_DIR = tmp_path / "workspaces"
    mgr.WORKSPACES_DIR.mkdir(exist_ok=True)
    return mgr


class TestValidateWorkspaceName:
    def test_valid_name(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._validate_workspace_name("my-workspace")

    def test_valid_name_with_underscore(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._validate_workspace_name("my_workspace")

    def test_valid_alphanumeric(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._validate_workspace_name("workspace123")

    def test_invalid_with_space(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            mgr._validate_workspace_name("my workspace")

    def test_invalid_empty(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            mgr._validate_workspace_name("")

    def test_invalid_too_long(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(InvalidWorkspaceNameError):
            mgr._validate_workspace_name("a" * 65)

    def test_reserved_primary(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(InvalidWorkspaceNameError, match="reserved"):
            mgr._validate_workspace_name("primary")

    def test_reserved_deleted_backups(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(InvalidWorkspaceNameError, match="reserved"):
            mgr._validate_workspace_name("_deleted_backups")


class TestIsWorkspaceDiscoverable:
    def test_valid_name_discoverable(self, tmp_path):
        mgr = _make_manager(tmp_path)
        assert mgr._is_workspace_discoverable("myworkspace") is True

    def test_dot_prefix_not_discoverable(self, tmp_path):
        mgr = _make_manager(tmp_path)
        assert mgr._is_workspace_discoverable(".hidden") is False

    def test_reserved_name_not_discoverable(self, tmp_path):
        mgr = _make_manager(tmp_path)
        assert mgr._is_workspace_discoverable("primary") is False

    def test_space_in_name_not_discoverable(self, tmp_path):
        mgr = _make_manager(tmp_path)
        assert mgr._is_workspace_discoverable("my workspace") is False


class TestPgEnv:
    def test_includes_pgpassfile_when_set(self, tmp_path):
        mgr = _make_manager(tmp_path)
        db_cfg = {"host": "db", "port": 5432, "database": "caracal", "user": "caracal", "password": "mypassword"}
        with mgr._pg_env(db_cfg) as env:
            pgpass_path = Path(env["PGPASSFILE"])
            assert pgpass_path.read_text(encoding="utf-8").strip().endswith(":mypassword")
        assert not pgpass_path.exists()

    def test_no_pgpassfile_on_empty(self, tmp_path):
        mgr = _make_manager(tmp_path)
        db_cfg = {"host": "db", "port": 5432, "database": "caracal", "user": "caracal", "password": ""}
        with mgr._pg_env(db_cfg) as env:
            assert "PGPASSFILE" not in env
            assert "PGPASSWORD" not in env

    def test_includes_existing_env_vars(self, tmp_path):
        mgr = _make_manager(tmp_path)
        db_cfg = {"host": "db", "port": 5432, "database": "caracal", "user": "caracal", "password": "pass"}
        with mgr._pg_env(db_cfg) as env:
            assert "PATH" in env or len(env) > 1


class TestNormalizeLockKey:
    def test_strips_whitespace(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with patch("caracal.deployment.config_manager.normalize_optional_text", return_value="stripped"):
            result = mgr._normalize_lock_key("  key  ")
        assert result == "stripped"

    def test_returns_none_on_none(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with patch("caracal.deployment.config_manager.normalize_optional_text", return_value=None):
            result = mgr._normalize_lock_key(None)
        assert result is None


class TestValidateLockKey:
    def test_valid_key_passes(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._validate_lock_key("validpassword123")

    def test_short_key_raises(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(WorkspaceOperationError, match="12 characters"):
            mgr._validate_lock_key("short")

    def test_exactly_12_passes(self, tmp_path):
        mgr = _make_manager(tmp_path)
        mgr._validate_lock_key("a" * 12)

    def test_11_chars_raises(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(WorkspaceOperationError):
            mgr._validate_lock_key("a" * 11)


class TestDeriveArchiveKey:
    def test_returns_32_bytes(self, tmp_path):
        mgr = _make_manager(tmp_path)
        key = mgr._derive_archive_key("mypassword123", b"saltsaltsalt1234", 1000)
        assert len(key) == 32

    def test_deterministic_with_same_inputs(self, tmp_path):
        mgr = _make_manager(tmp_path)
        salt = b"saltsaltsalt1234"
        key1 = mgr._derive_archive_key("mypassword123", salt, 1000)
        key2 = mgr._derive_archive_key("mypassword123", salt, 1000)
        assert key1 == key2

    def test_different_passwords_give_different_keys(self, tmp_path):
        mgr = _make_manager(tmp_path)
        salt = b"saltsaltsalt1234"
        key1 = mgr._derive_archive_key("password1234", salt, 1000)
        key2 = mgr._derive_archive_key("password5678", salt, 1000)
        assert key1 != key2


class TestEncryptArchivePayload:
    def test_produces_magic_prefix(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr._encrypt_archive_payload(b"hello world", "validpassword123")
        assert result.startswith(ConfigManager.ARCHIVE_LOCK_MAGIC)

    def test_short_key_raises(self, tmp_path):
        mgr = _make_manager(tmp_path)
        with pytest.raises(WorkspaceOperationError):
            mgr._encrypt_archive_payload(b"data", "short")

    def test_result_is_bytes(self, tmp_path):
        mgr = _make_manager(tmp_path)
        result = mgr._encrypt_archive_payload(b"test data", "validpassword123")
        assert isinstance(result, bytes)

    def test_different_runs_produce_different_output(self, tmp_path):
        mgr = _make_manager(tmp_path)
        r1 = mgr._encrypt_archive_payload(b"test", "validpassword123")
        r2 = mgr._encrypt_archive_payload(b"test", "validpassword123")
        assert r1 != r2


class TestExtractWorkspaceDbConfig:
    def test_returns_none_when_no_config_yaml(self, tmp_path):
        mgr = _make_manager(tmp_path)
        workspace_dir = tmp_path / "workspace1"
        workspace_dir.mkdir()
        result = mgr._extract_workspace_db_config(workspace_dir)
        assert result is None

    def test_returns_none_when_no_schema(self, tmp_path):
        import yaml
        mgr = _make_manager(tmp_path)
        workspace_dir = tmp_path / "workspace1"
        workspace_dir.mkdir()
        (workspace_dir / "config.yaml").write_text(yaml.dump({"database": {"host": "localhost"}}))
        result = mgr._extract_workspace_db_config(workspace_dir)
        assert result is None

    def test_returns_config_with_schema(self, tmp_path):
        import yaml
        mgr = _make_manager(tmp_path)
        workspace_dir = tmp_path / "workspace1"
        workspace_dir.mkdir()
        (workspace_dir / "config.yaml").write_text(yaml.dump({
            "database": {"host": "dbhost", "port": 5432, "schema": "workspace_test", "database": "caracal", "user": "u"}
        }))
        result = mgr._extract_workspace_db_config(workspace_dir)
        assert result is not None
        assert result["schema"] == "workspace_test"
        assert result["host"] == "dbhost"
