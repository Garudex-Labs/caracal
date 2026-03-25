"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for migration system.
"""

import tempfile
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

import pytest

from caracal.deployment.migration import MigrationManager
from caracal.deployment.edition import Edition
from caracal.deployment.exceptions import (
    MigrationError,
    BackupError,
    RestoreError,
    MigrationValidationError,
)


@pytest.fixture
def migration_manager():
    """Create a migration manager instance for testing."""
    with patch('caracal.deployment.migration.ConfigManager'):
        with patch('caracal.deployment.migration.EditionManager'):
            manager = MigrationManager()
            return manager


@pytest.fixture
def temp_backup_dir(tmp_path):
    """Create a temporary backup directory."""
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    return backup_dir


class TestMigrationManager:
    """Tests for MigrationManager class."""
    
    def test_initialization(self, migration_manager):
        """Test migration manager initialization."""
        assert migration_manager is not None
        assert hasattr(migration_manager, 'config_manager')
        assert hasattr(migration_manager, 'edition_manager')
    
    def test_generate_migration_id(self, migration_manager):
        """Test migration ID generation."""
        migration_id = migration_manager._generate_migration_id("test_migration")
        
        assert migration_id.startswith("test_migration_")
        assert len(migration_id) > len("test_migration_")
    
    def test_calculate_checksum(self, migration_manager, tmp_path):
        """Test checksum calculation."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("test content")
        
        checksum = migration_manager._calculate_checksum(test_file)
        
        assert checksum is not None
        assert len(checksum) == 64  # SHA-256 produces 64 hex characters
        
        # Verify checksum is consistent
        checksum2 = migration_manager._calculate_checksum(test_file)
        assert checksum == checksum2
    
    def test_detect_repository_installation_not_found(self, migration_manager):
        """Test repository detection when no repository is found."""
        with patch('pathlib.Path.exists', return_value=False):
            result = migration_manager._detect_repository_installation()
            assert result is None
    
    def test_detect_repository_installation_found(self, migration_manager, tmp_path):
        """Test repository detection when repository is found."""
        # Create a mock repository structure
        repo_dir = tmp_path / "caracal"
        repo_dir.mkdir()
        (repo_dir / "caracal").mkdir()
        (repo_dir / "setup.py").touch()
        
        with patch('pathlib.Path.cwd', return_value=repo_dir):
            result = migration_manager._detect_repository_installation()
            assert result == repo_dir
    
    def test_preserve_migration_data(self, migration_manager):
        """Test data preservation during migration."""
        # Mock workspace list
        migration_manager.config_manager.list_workspaces.return_value = [
            "workspace1",
            "workspace2"
        ]
        
        # Mock workspace config
        mock_config = Mock()
        migration_manager.config_manager.get_workspace_config.return_value = mock_config
        
        result = migration_manager._preserve_migration_data(None)
        
        assert result == 2
        assert migration_manager.config_manager.list_workspaces.called
    
    def test_migrate_api_keys_opensource_to_enterprise(self, migration_manager):
        """Test API key migration from Open Source to Enterprise."""
        migration_manager.config_manager.list_workspaces.return_value = [
            "workspace1"
        ]
        
        result = migration_manager._migrate_api_keys(
            Edition.OPENSOURCE,
            Edition.ENTERPRISE,
            "https://gateway.example.com",
            "test_token"
        )
        
        assert result >= 0
    
    def test_migrate_api_keys_enterprise_to_opensource(self, migration_manager):
        """Test API key migration from Enterprise to Open Source."""
        result = migration_manager._migrate_api_keys(
            Edition.ENTERPRISE,
            Edition.OPENSOURCE,
            None,
            None
        )
        
        assert result >= 0
    
    def test_migrate_edition_settings(self, migration_manager):
        """Test edition settings migration."""
        # Should not raise any exceptions
        migration_manager._migrate_edition_settings(
            Edition.OPENSOURCE,
            Edition.ENTERPRISE
        )
    
    def test_create_backup(self, migration_manager, tmp_path):
        """Test backup creation."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            with patch('pathlib.Path.home', return_value=tmp_path):
                # Create a mock .caracal directory
                caracal_dir = tmp_path / ".caracal"
                caracal_dir.mkdir()
                (caracal_dir / "config.toml").write_text("test config")
                
                backup_path = migration_manager._create_backup(
                    "test_migration",
                    "test_backup"
                )
                
                assert backup_path.exists()
                assert backup_path.suffix == ".gz"
                
                # Verify checksum file was created
                checksum_file = backup_path.with_suffix(".tar.gz.sha256")
                assert checksum_file.exists()
    
    def test_create_backup_no_config_dir(self, migration_manager, tmp_path):
        """Test backup creation when config directory doesn't exist."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            with patch('pathlib.Path.home', return_value=tmp_path):
                backup_path = migration_manager._create_backup(
                    "test_migration",
                    "test_backup"
                )
                
                # Should create an empty backup
                assert backup_path.exists()
    
    def test_list_backups_empty(self, migration_manager, tmp_path):
        """Test listing backups when no backups exist."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            backups = migration_manager.list_backups()
            assert backups == []
    
    def test_list_backups_with_backups(self, migration_manager, tmp_path):
        """Test listing backups when backups exist."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            # Create mock backup files
            backup1 = tmp_path / "backup_test1_123.tar.gz"
            backup1.write_text("backup1")
            
            backup2 = tmp_path / "backup_test2_456.tar.gz"
            backup2.write_text("backup2")
            
            # Create checksum for backup1
            checksum1 = backup1.with_suffix(".tar.gz.sha256")
            checksum1.write_text("checksum1")
            
            backups = migration_manager.list_backups()
            
            assert len(backups) == 2
            assert all('path' in b for b in backups)
            assert all('name' in b for b in backups)
            assert all('size_bytes' in b for b in backups)
            assert all('created_at' in b for b in backups)
            assert all('has_checksum' in b for b in backups)
    
    def test_cleanup_old_backups(self, migration_manager, tmp_path):
        """Test cleanup of old backups."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            with patch.object(migration_manager, 'MAX_BACKUPS', 2):
                # Create 4 backup files
                for i in range(4):
                    backup = tmp_path / f"backup_test{i}_123.tar.gz"
                    backup.write_text(f"backup{i}")
                
                migration_manager._cleanup_old_backups()
                
                # Should only have 2 backups remaining
                remaining_backups = list(tmp_path.glob("backup_*.tar.gz"))
                assert len(remaining_backups) == 2
    
    def test_migrate_repository_to_package_success(self, migration_manager, tmp_path):
        """Test successful repository to package migration."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            with patch('pathlib.Path.home', return_value=tmp_path):
                # Create mock .caracal directory
                caracal_dir = tmp_path / ".caracal"
                caracal_dir.mkdir()
                
                # Mock methods
                migration_manager.config_manager.list_workspaces.return_value = []
                
                result = migration_manager.migrate_repository_to_package(
                    repository_path=None,
                    preserve_data=True,
                    verify_integrity=True
                )
                
                assert result['success'] is True
                assert 'migration_id' in result
                assert 'workspaces_migrated' in result
                assert 'backup_path' in result
                assert 'duration_ms' in result
    
    def test_migrate_edition_success(self, migration_manager, tmp_path):
        """Test successful edition migration."""
        with patch.object(migration_manager, 'BACKUP_DIR', tmp_path):
            with patch('pathlib.Path.home', return_value=tmp_path):
                # Create mock .caracal directory
                caracal_dir = tmp_path / ".caracal"
                caracal_dir.mkdir()
                
                # Mock edition manager
                migration_manager.edition_manager.get_edition.return_value = Edition.OPENSOURCE
                migration_manager.config_manager.list_workspaces.return_value = []
                
                result = migration_manager.migrate_edition(
                    target_edition=Edition.ENTERPRISE,
                    gateway_url="https://gateway.example.com",
                    gateway_token="test_token",
                    migrate_api_keys=True
                )
                
                assert result['success'] is True
                assert 'migration_id' in result
                assert 'from_edition' in result
                assert 'to_edition' in result
                assert 'api_keys_migrated' in result
                assert 'backup_path' in result
    
    def test_migrate_edition_same_edition_error(self, migration_manager):
        """Test edition migration fails when target is same as current."""
        migration_manager.edition_manager.get_edition.return_value = Edition.OPENSOURCE
        
        with pytest.raises(MigrationError, match="Already running"):
            migration_manager.migrate_edition(
                target_edition=Edition.OPENSOURCE,
                gateway_url=None,
                gateway_token=None,
                migrate_api_keys=True
            )
    
    def test_migrate_edition_missing_gateway_url(self, migration_manager):
        """Test edition migration fails when gateway URL is missing for Enterprise."""
        migration_manager.edition_manager.get_edition.return_value = Edition.OPENSOURCE
        
        with pytest.raises(MigrationError, match="Gateway URL is required"):
            migration_manager.migrate_edition(
                target_edition=Edition.ENTERPRISE,
                gateway_url=None,
                gateway_token=None,
                migrate_api_keys=True
            )
    
    def test_restore_backup_file_not_found(self, migration_manager, tmp_path):
        """Test restore fails when backup file doesn't exist."""
        backup_path = tmp_path / "nonexistent.tar.gz"
        
        with pytest.raises(RestoreError, match="Backup file not found"):
            migration_manager.restore_backup(backup_path)
    
    def test_verify_data_integrity_success(self, migration_manager, tmp_path):
        """Test data integrity verification success."""
        # Create a mock backup
        backup_path = tmp_path / "backup.tar.gz"
        backup_path.write_text("backup")
        
        # Create checksum
        checksum = migration_manager._calculate_checksum(backup_path)
        checksum_file = backup_path.with_suffix(".tar.gz.sha256")
        checksum_file.write_text(checksum)
        
        # Mock workspace list
        migration_manager.config_manager.list_workspaces.return_value = ["workspace1"]
        migration_manager.config_manager.get_workspace_config.return_value = Mock()
        
        # Should not raise any exceptions
        migration_manager._verify_data_integrity(backup_path)
    
    def test_verify_data_integrity_checksum_mismatch(self, migration_manager, tmp_path):
        """Test data integrity verification fails on checksum mismatch."""
        # Create a mock backup
        backup_path = tmp_path / "backup.tar.gz"
        backup_path.write_text("backup")
        
        # Create incorrect checksum
        checksum_file = backup_path.with_suffix(".tar.gz.sha256")
        checksum_file.write_text("incorrect_checksum")
        
        # Mock workspace list
        migration_manager.config_manager.list_workspaces.return_value = []
        
        with pytest.raises(MigrationValidationError, match="checksum mismatch"):
            migration_manager._verify_data_integrity(backup_path)
