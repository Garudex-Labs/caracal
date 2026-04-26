"""
Unit tests for database connection management.

This module tests database connection establishment, pooling, and error handling.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from sqlalchemy.exc import OperationalError

from caracal.db.connection import (
    DatabaseConfig,
    DatabaseConnectionManager,
    initialize_connection_manager,
    get_connection_manager,
    close_connection_manager,
)


@pytest.mark.unit
class TestDatabaseConfig:
    """Test suite for DatabaseConfig."""

    @pytest.fixture(autouse=True)
    def _isolate_db_env(self, monkeypatch):
        for env_name in (
            "CCL_DB_HOST",
            "CCL_DB_PORT",
            "CCL_DB_NAME",
            "CCL_DB_USER",
            "CCL_DB_PASSWORD",
            "CCL_DB_SCHEMA",
        ):
            monkeypatch.delenv(env_name, raising=False)

        with patch("caracal.db.connection._ensure_dotenv_loaded", return_value=None):
            yield
    
    def test_config_creation_with_defaults(self):
        """Test DatabaseConfig instantiation with default values."""
        # Act
        config = DatabaseConfig()
        
        # Assert
        assert config.host == "localhost"
        assert config.port == 5432
        assert config.database == "caracal"
        assert config.user == "caracal"
        assert config.password == ""
        assert config.pool_size == 10
        assert config.max_overflow == 5
    
    def test_config_creation_with_custom_values(self):
        """Test DatabaseConfig instantiation with custom values."""
        # Act
        config = DatabaseConfig(
            host="db.example.com",
            port=5433,
            database="test_db",
            user="test_user",
            password="test_pass",
            pool_size=20,
            max_overflow=10
        )
        
        # Assert
        assert config.host == "db.example.com"
        assert config.port == 5433
        assert config.database == "test_db"
        assert config.user == "test_user"
        assert config.password == "test_pass"
        assert config.pool_size == 20
        assert config.max_overflow == 10
    
    def test_get_connection_url(self):
        """Test connection URL generation."""
        # Arrange
        config = DatabaseConfig(
            host="localhost",
            port=5432,
            database="caracal",
            user="test_user",
            password="test_pass"
        )
        
        # Act
        url = config.get_connection_url()
        
        # Assert
        assert url.startswith("postgresql://")
        assert "test_user" in url
        assert "localhost" in url
        assert "5432" in url
        assert "caracal" in url
    
    def test_get_connection_url_with_special_chars(self):
        """Test connection URL generation with special characters in password."""
        # Arrange
        config = DatabaseConfig(
            host="localhost",
            port=5432,
            database="caracal",
            user="test_user",
            password="p@ss:word!"
        )
        
        # Act
        url = config.get_connection_url()
        
        # Assert
        assert "postgresql://" in url
        # Password should be URL-encoded
        assert "p@ss:word!" not in url
        assert "p%40ss%3Aword%21" in url or "p%40ss%3aword%21" in url


@pytest.mark.unit
class TestDatabaseConnectionManager:
    """Test suite for DatabaseConnectionManager."""
    
    def test_manager_creation(self):
        """Test DatabaseConnectionManager instantiation."""
        # Arrange
        config = DatabaseConfig()
        
        # Act
        manager = DatabaseConnectionManager(config)
        
        # Assert
        assert manager.config == config
        assert manager._engine is None
        assert manager._session_factory is None
        assert manager._initialized is False
    
    @patch('caracal.db.connection.create_engine')
    def test_initialize_success(self, mock_create_engine):
        """Test successful database initialization."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine and connection
        mock_engine = MagicMock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        mock_create_engine.return_value = mock_engine
        
        # Act
        with patch('caracal.db.connection.sessionmaker'):
            with patch('caracal.db.models.Base'):
                manager.initialize()
        
        # Assert
        assert manager._initialized is True
        assert manager._engine is not None
        mock_create_engine.assert_called_once()
    
    @patch('caracal.db.connection.create_engine')
    def test_initialize_connection_failure(self, mock_create_engine):
        """Test database initialization with connection failure."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine that raises OperationalError
        mock_engine = MagicMock()
        mock_engine.connect.side_effect = OperationalError("Connection failed", None, None)
        mock_create_engine.return_value = mock_engine
        
        # Act & Assert
        with pytest.raises(Exception):  # Should raise CaracalError
            manager.initialize()
    
    def test_get_session_before_initialization(self):
        """Test get_session raises error when not initialized."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Act & Assert
        with pytest.raises(RuntimeError, match="not initialized"):
            manager.get_session()
    
    @patch('caracal.db.connection.create_engine')
    def test_health_check_success(self, mock_create_engine):
        """Test successful health check."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine and connection
        mock_engine = MagicMock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        mock_create_engine.return_value = mock_engine
        
        with patch('caracal.db.connection.sessionmaker'):
            with patch('caracal.db.models.Base'):
                manager.initialize()
        
        # Act
        result = manager.health_check()
        
        # Assert
        assert result is True
    
    @patch('caracal.db.connection.create_engine')
    def test_health_check_failure(self, mock_create_engine):
        """Test health check with database error."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine that raises error on health check
        mock_engine = MagicMock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        mock_create_engine.return_value = mock_engine
        
        with patch('caracal.db.connection.sessionmaker'):
            with patch('caracal.db.models.Base'):
                manager.initialize()
        
        # Make health check fail
        mock_engine.connect.side_effect = Exception("Connection lost")
        
        # Act
        result = manager.health_check()
        
        # Assert
        assert result is False
    
    @patch('caracal.db.connection.create_engine')
    def test_get_pool_status(self, mock_create_engine):
        """Test connection pool status retrieval."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine with pool
        mock_engine = MagicMock()
        mock_pool = MagicMock()
        mock_pool.size.return_value = 10
        mock_pool.checkedin.return_value = 8
        mock_pool.checkedout.return_value = 2
        mock_pool.overflow.return_value = 0
        mock_engine.pool = mock_pool
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        mock_create_engine.return_value = mock_engine
        
        with patch('caracal.db.connection.sessionmaker'):
            with patch('caracal.db.models.Base'):
                manager.initialize()
        
        # Act
        status = manager.get_pool_status()
        
        # Assert
        assert status["size"] == 10
        assert status["checked_in"] == 8
        assert status["checked_out"] == 2
        assert status["overflow"] == 0
        assert status["total"] == 10
    
    @patch('caracal.db.connection.create_engine')
    def test_close_connection_manager(self, mock_create_engine):
        """Test closing connection manager."""
        # Arrange
        config = DatabaseConfig()
        manager = DatabaseConnectionManager(config)
        
        # Mock engine
        mock_engine = MagicMock()
        mock_connection = MagicMock()
        mock_engine.connect.return_value.__enter__.return_value = mock_connection
        mock_create_engine.return_value = mock_engine
        
        with patch('caracal.db.connection.sessionmaker'):
            with patch('caracal.db.models.Base'):
                manager.initialize()
        
        # Act
        manager.close()
        
        # Assert
        assert manager._engine is None
        assert manager._session_factory is None
        assert manager._initialized is False
        mock_engine.dispose.assert_called_once()


@pytest.mark.unit
class TestGlobalConnectionManager:
    """Test suite for global connection manager functions."""
    
    def test_get_connection_manager_before_init(self):
        """Test get_connection_manager raises error when not initialized."""
        # Arrange
        close_connection_manager()  # Ensure clean state
        
        # Act & Assert
        with pytest.raises(RuntimeError, match="initialize_connection_manager"):
            get_connection_manager()
    
    @patch('caracal.db.connection.DatabaseConnectionManager.initialize')
    def test_initialize_and_get_connection_manager(self, mock_initialize):
        """Test initializing and retrieving global connection manager."""
        # Arrange
        config = DatabaseConfig()
        
        # Act
        manager = initialize_connection_manager(config)
        retrieved_manager = get_connection_manager()
        
        # Assert
        assert manager is retrieved_manager
        mock_initialize.assert_called_once()
        
        # Cleanup
        close_connection_manager()
    
    @patch('caracal.db.connection.DatabaseConnectionManager.initialize')
    @patch('caracal.db.connection.DatabaseConnectionManager.close')
    def test_close_global_connection_manager(self, mock_close, mock_initialize):
        """Test closing global connection manager."""
        # Arrange
        config = DatabaseConfig()
        initialize_connection_manager(config)
        
        # Act
        close_connection_manager()
        
        # Assert
        mock_close.assert_called_once()
        
        # Verify manager is cleared
        with pytest.raises(RuntimeError):
            get_connection_manager()
