"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for ConfigManager.
"""

import json
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

from caracal.deployment.config_manager import (
    ConfigManager,
    ConflictStrategy,
    PostgresConfig,
    SyncDirection,
    WorkspaceConfig,
)
from caracal.deployment.exceptions import (
    InvalidWorkspaceNameError,
    SecretNotFoundError,
    WorkspaceAlreadyExistsError,
    WorkspaceNotFoundError,
)


@pytest.fixture
def temp_config_dir(monkeypatch, tmp_path):
    """Create a temporary configuration directory for testing."""
    config_dir = tmp_path / ".caracal"
    monkeypatch.setattr("caracal.deployment.config_manager.ConfigManager.CONFIG_DIR", config_dir)
    monkeypatch.setattr(
        "caracal.deployment.config_manager.ConfigManager.CONFIG_FILE",
        config_dir / "config.toml"
    )
    monkeypatch.setattr(
        "caracal.deployment.config_manager.ConfigManager.WORKSPACES_DIR",
        config_dir / "workspaces"
    )
    monkeypatch.setattr(
        "caracal.deployment.config_manager.ConfigManager.CACHE_DIR",
        config_dir / "cache"
    )
    monkeypatch.setattr(
        "caracal.deployment.config_manager.ConfigManager.LOGS_DIR",
        config_dir / "logs"
    )
    return config_dir


class TestConfigManagerBasics:
    """Test basic ConfigManager functionality."""
    
    def test_initialization_creates_directories(self, temp_config_dir):
        """Test that initialization creates required directories."""
        manager = ConfigManager()
        
        assert temp_config_dir.exists()
        assert (temp_config_dir / "workspaces").exists()
        assert (temp_config_dir / "cache").exists()
        assert (temp_config_dir / "logs").exists()
    
    def test_list_workspaces_empty(self, temp_config_dir):
        """Test listing workspaces when none exist."""
        manager = ConfigManager()
        workspaces = manager.list_workspaces()
        
        assert workspaces == []

    def test_list_workspaces_ignores_reserved_internal_dirs(self, temp_config_dir, monkeypatch):
        """Internal bookkeeping folders must never appear as user workspaces."""
        monkeypatch.setattr(
            "caracal.flow.workspace.WorkspaceManager.list_workspaces",
            lambda registry_path=None: [],
        )

        manager = ConfigManager()
        internal_dir = temp_config_dir / "workspaces" / "_deleted_backups"
        internal_dir.mkdir(parents=True)
        (internal_dir / "workspace.toml").write_text("is_default = true\n", encoding="utf-8")

        workspaces = manager.list_workspaces()

        assert workspaces == []
    
    def test_create_workspace_basic(self, temp_config_dir):
        """Test creating a basic workspace."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        workspaces = manager.list_workspaces()
        assert "test-workspace" in workspaces
        
        # Verify workspace directory exists
        workspace_dir = temp_config_dir / "workspaces" / "test-workspace"
        assert workspace_dir.exists()
        assert (workspace_dir / "workspace.toml").exists()
        assert (workspace_dir / "secrets.vault").exists()
    
    def test_create_workspace_with_template(self, temp_config_dir):
        """Test creating workspace with template."""
        manager = ConfigManager()
        manager.create_workspace("enterprise-ws", template="enterprise")
        
        config = manager.get_workspace_config("enterprise-ws")
        assert config.sync_enabled is True
        assert config.sync_direction == SyncDirection.BIDIRECTIONAL
        assert config.auto_sync_interval == 300
        assert config.conflict_strategy == ConflictStrategy.OPERATIONAL_TRANSFORM
    
    def test_create_workspace_invalid_name(self, temp_config_dir):
        """Test creating workspace with invalid name."""
        manager = ConfigManager()
        
        with pytest.raises(InvalidWorkspaceNameError):
            manager.create_workspace("invalid name!")
        
        with pytest.raises(InvalidWorkspaceNameError):
            manager.create_workspace("a" * 65)  # Too long
    
    def test_create_workspace_already_exists(self, temp_config_dir):
        """Test creating workspace that already exists."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        with pytest.raises(WorkspaceAlreadyExistsError):
            manager.create_workspace("test-workspace")
    
    def test_get_workspace_config(self, temp_config_dir):
        """Test getting workspace configuration."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        config = manager.get_workspace_config("test-workspace")
        
        assert config.name == "test-workspace"
        assert isinstance(config.created_at, datetime)
        assert isinstance(config.updated_at, datetime)
        assert config.is_default is True  # First workspace is default
        assert config.sync_enabled is False
    
    def test_get_workspace_config_not_found(self, temp_config_dir):
        """Test getting configuration for non-existent workspace."""
        manager = ConfigManager()
        
        with pytest.raises(WorkspaceNotFoundError):
            manager.get_workspace_config("nonexistent")
    
    def test_set_workspace_config(self, temp_config_dir):
        """Test updating workspace configuration."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        config = manager.get_workspace_config("test-workspace")
        config.sync_enabled = True
        config.sync_url = "https://example.com/sync"
        config.metadata["custom"] = "value"
        
        manager.set_workspace_config("test-workspace", config)
        
        # Verify changes persisted
        updated_config = manager.get_workspace_config("test-workspace")
        assert updated_config.sync_enabled is True
        assert updated_config.sync_url == "https://example.com/sync"
        assert updated_config.metadata["custom"] == "value"
    
    def test_delete_workspace(self, temp_config_dir):
        """Test deleting workspace."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        assert "test-workspace" in manager.list_workspaces()
        
        manager.delete_workspace("test-workspace", backup=False)
        
        assert "test-workspace" not in manager.list_workspaces()
    
    def test_delete_workspace_with_backup(self, temp_config_dir):
        """Test deleting workspace with backup."""
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        manager.delete_workspace("test-workspace", backup=True)
        
        # Verify backup was created
        backup_dir = temp_config_dir / "backups"
        assert backup_dir.exists()
        backups = list(backup_dir.glob("test-workspace_*.tar.gz"))
        assert len(backups) == 1
    
    def test_delete_workspace_not_found(self, temp_config_dir):
        """Test deleting non-existent workspace."""
        manager = ConfigManager()
        
        with pytest.raises(WorkspaceNotFoundError):
            manager.delete_workspace("nonexistent")


class TestConfigManagerSecrets:
    """Test secret management functionality."""
    
    def test_store_and_retrieve_secret(self, temp_config_dir, monkeypatch):
        """Test storing and retrieving a secret."""
        # Mock keyring to avoid system keyring dependency
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        # Store secret
        manager.store_secret("api_key", "secret-value-123", "test-workspace")
        
        # Retrieve secret
        value = manager.get_secret("api_key", "test-workspace")
        assert value == "secret-value-123"
    
    def test_get_secret_not_found(self, temp_config_dir, monkeypatch):
        """Test retrieving non-existent secret."""
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        with pytest.raises(SecretNotFoundError):
            manager.get_secret("nonexistent", "test-workspace")
    
    def test_store_secret_workspace_not_found(self, temp_config_dir, monkeypatch):
        """Test storing secret in non-existent workspace."""
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        
        with pytest.raises(WorkspaceNotFoundError):
            manager.store_secret("api_key", "value", "nonexistent")


class TestConfigManagerExportImport:
    """Test workspace export/import functionality."""
    
    def test_export_workspace(self, temp_config_dir, monkeypatch):
        """Test exporting workspace."""
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        manager.store_secret("api_key", "secret-value", "test-workspace")
        
        export_path = temp_config_dir / "export.tar.gz"
        manager.export_workspace("test-workspace", export_path, include_secrets=True)
        
        assert export_path.exists()
    
    def test_import_workspace(self, temp_config_dir, monkeypatch):
        """Test importing workspace."""
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        manager.create_workspace("original-workspace")
        manager.store_secret("api_key", "secret-value", "original-workspace")
        
        # Export
        export_path = temp_config_dir / "export.tar.gz"
        manager.export_workspace("original-workspace", export_path, include_secrets=True)
        
        # Delete original
        manager.delete_workspace("original-workspace", backup=False)
        
        # Import with new name
        manager.import_workspace(export_path, name="imported-workspace")
        
        assert "imported-workspace" in manager.list_workspaces()
        
        # Verify secret was imported
        value = manager.get_secret("api_key", "imported-workspace")
        assert value == "secret-value"
    
    def test_import_workspace_already_exists(self, temp_config_dir, monkeypatch):
        """Test importing workspace that already exists."""
        monkeypatch.setattr("keyring.get_password", lambda s, u: None)
        monkeypatch.setattr("keyring.set_password", lambda s, u, p: None)
        
        manager = ConfigManager()
        manager.create_workspace("test-workspace")
        
        export_path = temp_config_dir / "export.tar.gz"
        manager.export_workspace("test-workspace", export_path)
        
        with pytest.raises(WorkspaceAlreadyExistsError):
            manager.import_workspace(export_path, name="test-workspace")


class TestConfigManagerPostgres:
    """Test PostgreSQL configuration management."""
    
    def test_get_postgres_config_not_configured(self, temp_config_dir):
        """Test getting PostgreSQL config when not configured."""
        manager = ConfigManager()
        config = manager.get_postgres_config()
        
        assert config is None
    
    def test_set_and_get_postgres_config(self, temp_config_dir, monkeypatch):
        """Test setting and getting PostgreSQL configuration."""
        # Mock connectivity validation to avoid actual database connection
        monkeypatch.setattr(
            "caracal.deployment.config_manager.ConfigManager._validate_postgres_connectivity",
            lambda self, config: None
        )
        
        manager = ConfigManager()
        
        postgres_config = PostgresConfig(
            host="localhost",
            port=5432,
            database="caracal_test",
            user="caracal_user",
            password_ref="postgres_password",
            ssl_mode="require",
            pool_size=10,
            max_overflow=5,
            pool_timeout=30
        )
        
        manager.set_postgres_config(postgres_config)
        
        # Retrieve configuration
        retrieved_config = manager.get_postgres_config()
        
        assert retrieved_config is not None
        assert retrieved_config.host == "localhost"
        assert retrieved_config.port == 5432
        assert retrieved_config.database == "caracal_test"
        assert retrieved_config.user == "caracal_user"
        assert retrieved_config.password_ref == "postgres_password"

    def test_validate_postgres_connectivity_uses_env_password(
        self, temp_config_dir, monkeypatch
    ):
        """Connectivity validation should prefer CARACAL_DB_PASSWORD when set."""
        captured = {}

        class FakeDatabaseConfig:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        class FakeConnectionManager:
            def __init__(self, config):
                self.config = config

            def initialize(self):
                return None

            def health_check(self):
                return True

            def close(self):
                return None

        monkeypatch.setenv("CARACAL_DB_PASSWORD", "env-secret")
        monkeypatch.setattr("caracal.db.connection.DatabaseConfig", FakeDatabaseConfig)
        monkeypatch.setattr(
            "caracal.db.connection.DatabaseConnectionManager", FakeConnectionManager
        )

        manager = ConfigManager()
        postgres_config = PostgresConfig(
            host="localhost",
            port=5432,
            database="caracal",
            user="caracal",
            password_ref="postgres_password",
            ssl_mode="require",
            pool_size=10,
            max_overflow=5,
            pool_timeout=30,
        )

        manager._validate_postgres_connectivity(postgres_config)

        assert captured["password"] == "env-secret"

    def test_validate_postgres_connectivity_searches_all_workspaces(
        self, temp_config_dir, monkeypatch
    ):
        """Validation should fall back across default and discovered workspace vaults."""
        captured = {}
        queried = []

        class FakeDatabaseConfig:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        class FakeConnectionManager:
            def __init__(self, config):
                self.config = config

            def initialize(self):
                return None

            def health_check(self):
                return True

            def close(self):
                return None

        def fake_get_secret(key, workspace):
            queried.append(workspace)
            if workspace == "ws-b":
                return "vault-secret"
            raise SecretNotFoundError(f"Missing secret for {workspace}")

        monkeypatch.delenv("CARACAL_DB_PASSWORD", raising=False)
        monkeypatch.setattr("caracal.db.connection.DatabaseConfig", FakeDatabaseConfig)
        monkeypatch.setattr(
            "caracal.db.connection.DatabaseConnectionManager", FakeConnectionManager
        )

        manager = ConfigManager()
        monkeypatch.setattr(manager, "get_default_workspace_name", lambda: "ws-default")
        monkeypatch.setattr(manager, "list_workspaces", lambda: ["ws-a", "ws-default", "ws-b"])
        monkeypatch.setattr(manager, "get_secret", fake_get_secret)

        postgres_config = PostgresConfig(
            host="localhost",
            port=5432,
            database="caracal",
            user="caracal",
            password_ref="postgres_password",
            ssl_mode="require",
            pool_size=10,
            max_overflow=5,
            pool_timeout=30,
        )

        manager._validate_postgres_connectivity(postgres_config)

        assert captured["password"] == "vault-secret"
        assert queried == ["ws-default", "ws-a", "ws-b"]
