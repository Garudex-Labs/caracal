"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for migration workflow.
"""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from caracal.deployment.migration import MigrationManager
from caracal.deployment.edition import Edition


class TestMigrationWorkflow:
    """Integration tests for migration workflows."""
    
    def test_repository_to_package_migration_workflow(self, tmp_path):
        """Test complete repository to package migration workflow."""
        with patch('caracal.deployment.migration.ConfigManager'):
            with patch('caracal.deployment.migration.EditionManager'):
                with patch.object(MigrationManager, 'BACKUP_DIR', tmp_path / "backups"):
                    with patch('pathlib.Path.home', return_value=tmp_path):
                        # Create mock .caracal directory
                        caracal_dir = tmp_path / ".caracal"
                        caracal_dir.mkdir()
                        (caracal_dir / "config.toml").write_text("test config")
                        
                        # Create migration manager
                        manager = MigrationManager()
                        manager.config_manager.list_workspaces.return_value = ["default"]
                        manager.config_manager.get_workspace_config.return_value = object()
                        
                        # Perform migration
                        result = manager.migrate_repository_to_package(
                            repository_path=None,
                            preserve_data=True,
                            verify_integrity=True
                        )
                        
                        # Verify result
                        assert result['success'] is True
                        assert result['migration_type'] == 'repository_to_package'
                        assert 'migration_id' in result
                        assert 'backup_path' in result
                        
                        # Verify backup was created
                        backup_path = Path(result['backup_path'])
                        assert backup_path.exists()
    
    def test_edition_switch_workflow(self, tmp_path):
        """Test complete edition switch workflow."""
        with patch('caracal.deployment.migration.ConfigManager'):
            with patch('caracal.deployment.migration.EditionManager'):
                with patch.object(MigrationManager, 'BACKUP_DIR', tmp_path / "backups"):
                    with patch('pathlib.Path.home', return_value=tmp_path):
                        # Create mock .caracal directory
                        caracal_dir = tmp_path / ".caracal"
                        caracal_dir.mkdir()
                        (caracal_dir / "config.toml").write_text("test config")
                        
                        # Create migration manager
                        manager = MigrationManager()
                        manager.edition_manager.get_edition.return_value = Edition.OPENSOURCE
                        manager.config_manager.list_workspaces.return_value = ["default"]
                        
                        # Perform edition switch
                        result = manager.migrate_edition(
                            target_edition=Edition.ENTERPRISE,
                            gateway_url="https://gateway.example.com",
                            gateway_token="test_token",
                            migrate_api_keys=True
                        )
                        
                        # Verify result
                        assert result['success'] is True
                        assert result['migration_type'] == 'edition_switch'
                        assert result['from_edition'] == 'opensource'
                        assert result['to_edition'] == 'enterprise'
                        assert 'migration_id' in result
                        assert 'backup_path' in result
                        
                        # Verify backup was created
                        backup_path = Path(result['backup_path'])
                        assert backup_path.exists()
    
    def test_backup_and_restore_workflow(self, tmp_path):
        """Test backup creation and restoration workflow."""
        with patch('caracal.deployment.migration.ConfigManager'):
            with patch('caracal.deployment.migration.EditionManager'):
                with patch.object(MigrationManager, 'BACKUP_DIR', tmp_path / "backups"):
                    with patch('pathlib.Path.home', return_value=tmp_path):
                        # Create mock .caracal directory with content
                        caracal_dir = tmp_path / ".caracal"
                        caracal_dir.mkdir()
                        config_file = caracal_dir / "config.toml"
                        config_file.write_text("original config")
                        
                        # Create migration manager
                        manager = MigrationManager()
                        
                        # Create backup
                        backup_path = manager._create_backup("test_migration", "test_backup")
                        assert backup_path.exists()
                        
                        # Modify config
                        config_file.write_text("modified config")
                        assert config_file.read_text() == "modified config"
                        
                        # Restore from backup
                        manager._rollback_from_backup(backup_path)
                        
                        # Verify config was restored
                        assert config_file.exists()
                        assert config_file.read_text() == "original config"
