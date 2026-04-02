"""
Unit tests for database migrations.

This module tests migration execution, rollback, and schema version tracking.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from alembic.config import Config
from alembic.script import ScriptDirectory

from caracal.db.schema_version import (
    SchemaVersionManager,
    check_schema_version_on_startup,
)


@pytest.mark.unit
class TestSchemaVersionManager:
    """Test suite for SchemaVersionManager."""
    
    def test_manager_creation(self):
        """Test SchemaVersionManager instantiation."""
        # Arrange
        mock_engine = Mock()
        alembic_ini_path = "alembic.ini"
        
        # Act
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, alembic_ini_path)
        
        # Assert
        assert manager.engine == mock_engine
    
    def test_manager_creation_with_config_object(self):
        """Test SchemaVersionManager instantiation with Config object."""
        # Arrange
        mock_engine = Mock()
        mock_config = Mock(spec=Config)
        
        # Act
        manager = SchemaVersionManager(mock_engine, mock_config)
        
        # Assert
        assert manager.engine == mock_engine
        assert manager.alembic_config == mock_config
    
    @patch('caracal.db.schema_version.MigrationContext')
    def test_get_current_revision(self, mock_migration_context):
        """Test getting current database revision."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        revision = manager.get_current_revision()
        
        # Assert
        assert revision == "abc123"
        mock_migration_context.configure.assert_called_once()
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    def test_get_head_revision(self, mock_script_directory):
        """Test getting head revision from migration scripts."""
        # Arrange
        mock_engine = Mock()
        mock_script = Mock()
        mock_script.get_current_head.return_value = "def456"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        head = manager.get_head_revision()
        
        # Assert
        assert head == "def456"
        mock_script.get_current_head.assert_called_once()
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_is_up_to_date_true(self, mock_migration_context, mock_script_directory):
        """Test is_up_to_date returns True when schema is current."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision
        mock_script = Mock()
        mock_script.get_current_head.return_value = "abc123"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        result = manager.is_up_to_date()
        
        # Assert
        assert result is True
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_is_up_to_date_false(self, mock_migration_context, mock_script_directory):
        """Test is_up_to_date returns False when schema is outdated."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision (outdated)
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision (newer)
        mock_script = Mock()
        mock_script.get_current_head.return_value = "def456"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        result = manager.is_up_to_date()
        
        # Assert
        assert result is False
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_is_up_to_date_no_migrations(self, mock_migration_context, mock_script_directory):
        """Test is_up_to_date returns False when no migrations applied."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock no current revision
        mock_context = Mock()
        mock_context.get_current_revision.return_value = None
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision
        mock_script = Mock()
        mock_script.get_current_head.return_value = "abc123"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        result = manager.is_up_to_date()
        
        # Assert
        assert result is False
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_get_pending_migrations(self, mock_migration_context, mock_script_directory):
        """Test getting list of pending migrations."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock pending revisions
        mock_rev1 = Mock()
        mock_rev1.revision = "def456"
        mock_rev2 = Mock()
        mock_rev2.revision = "ghi789"
        
        mock_script = Mock()
        mock_script.get_current_head.return_value = "ghi789"
        mock_script.iterate_revisions.return_value = [mock_rev2, mock_rev1]
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        pending = manager.get_pending_migrations()
        
        # Assert
        assert len(pending) == 2
        assert "def456" in pending
        assert "ghi789" in pending
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_get_pending_migrations_none(self, mock_migration_context, mock_script_directory):
        """Test getting pending migrations when schema is up to date."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision (same as head)
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision (same as current)
        mock_script = Mock()
        mock_script.get_current_head.return_value = "abc123"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        pending = manager.get_pending_migrations()
        
        # Assert
        assert pending == []
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_check_schema_version_success(self, mock_migration_context, mock_script_directory):
        """Test check_schema_version succeeds when schema is current."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision (same as head)
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision
        mock_script = Mock()
        mock_script.get_current_head.return_value = "abc123"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        result = manager.check_schema_version(fail_on_outdated=True)
        
        # Assert
        assert result is True
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_check_schema_version_failure(self, mock_migration_context, mock_script_directory):
        """Test check_schema_version raises error when schema is outdated."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision (outdated)
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision (newer)
        mock_script = Mock()
        mock_script.get_current_head.return_value = "def456"
        mock_script.iterate_revisions.return_value = []
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act & Assert
        with pytest.raises(RuntimeError, match="Database schema is outdated"):
            manager.check_schema_version(fail_on_outdated=True)
    
    @patch('caracal.db.schema_version.command')
    def test_upgrade_to_head(self, mock_command):
        """Test upgrading database schema to head."""
        # Arrange
        mock_engine = Mock()
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        manager.upgrade_to_head()
        
        # Assert
        mock_command.upgrade.assert_called_once()
        args = mock_command.upgrade.call_args[0]
        assert args[1] == "head"
    
    @patch('caracal.db.schema_version.command')
    def test_downgrade_to_base(self, mock_command):
        """Test downgrading database schema to base."""
        # Arrange
        mock_engine = Mock()
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        manager.downgrade_to_base()
        
        # Assert
        mock_command.downgrade.assert_called_once()
        args = mock_command.downgrade.call_args[0]
        assert args[1] == "base"
    
    @patch('caracal.db.schema_version.ScriptDirectory')
    @patch('caracal.db.schema_version.MigrationContext')
    def test_get_schema_info(self, mock_migration_context, mock_script_directory):
        """Test getting comprehensive schema information."""
        # Arrange
        mock_engine = Mock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        
        # Mock current revision
        mock_context = Mock()
        mock_context.get_current_revision.return_value = "abc123"
        mock_migration_context.configure.return_value = mock_context
        
        # Mock head revision
        mock_script = Mock()
        mock_script.get_current_head.return_value = "abc123"
        mock_script_directory.from_config.return_value = mock_script
        
        with patch('caracal.db.schema_version.Config'):
            manager = SchemaVersionManager(mock_engine, "alembic.ini")
        
        # Act
        info = manager.get_schema_info()
        
        # Assert
        assert info["current_revision"] == "abc123"
        assert info["head_revision"] == "abc123"
        assert info["is_up_to_date"] is True
        assert info["pending_migrations"] == []


@pytest.mark.unit
class TestSchemaVersionStartupCheck:
    """Test suite for schema version startup check."""
    
    @patch('caracal.db.schema_version.SchemaVersionManager')
    def test_check_schema_version_on_startup_success(self, mock_manager_class):
        """Test successful schema version check on startup."""
        # Arrange
        mock_engine = Mock()
        mock_manager = Mock()
        mock_manager.check_schema_version.return_value = True
        mock_manager_class.return_value = mock_manager
        
        # Act
        check_schema_version_on_startup(mock_engine, "alembic.ini")
        
        # Assert
        mock_manager.check_schema_version.assert_called_once_with(fail_on_outdated=True)
    
    @patch('caracal.db.schema_version.SchemaVersionManager')
    def test_check_schema_version_on_startup_failure(self, mock_manager_class):
        """Test schema version check failure on startup."""
        # Arrange
        mock_engine = Mock()
        mock_manager = Mock()
        mock_manager.check_schema_version.side_effect = RuntimeError("Schema outdated")
        mock_manager_class.return_value = mock_manager
        
        # Act & Assert
        with pytest.raises(RuntimeError, match="Schema outdated"):
            check_schema_version_on_startup(mock_engine, "alembic.ini")
