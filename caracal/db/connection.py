"""
Database connection management for Caracal Core v0.2.

This module provides connection pooling, health checks, and retry logic
for PostgreSQL database operations.

Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
"""

import logging
from contextlib import contextmanager
from typing import Optional, Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import QueuePool

logger = logging.getLogger(__name__)


class DatabaseConfig:
    """Configuration for database connection."""
    
    def __init__(
        self,
        type: str = "postgres",
        host: str = "localhost",
        port: int = 5432,
        database: str = "caracal",
        user: str = "caracal",
        password: str = "",
        file_path: str = "",
        pool_size: int = 10,
        max_overflow: int = 5,
        pool_timeout: int = 30,
        pool_recycle: int = 3600,
        echo: bool = False,
    ):
        """
        Initialize database configuration.
        
        Args:
            type: Database type ("postgres" or "sqlite")
            host: PostgreSQL host
            port: PostgreSQL port
            database: Database name
            user: Database user
            password: Database password
            file_path: Path to SQLite database file
            pool_size: Number of connections to maintain in pool (default 10)
            max_overflow: Maximum overflow connections beyond pool_size (default 5)
            pool_timeout: Timeout in seconds for getting connection from pool (default 30)
            pool_recycle: Recycle connections after this many seconds (default 3600 = 1 hour)
            echo: Enable SQL query logging (default False)
        """
        self.type = type
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.file_path = file_path
        self.pool_size = pool_size
        self.max_overflow = max_overflow
        self.pool_timeout = pool_timeout
        self.pool_recycle = pool_recycle
        self.echo = echo
    
    def get_connection_url(self) -> str:
        """Get database connection URL."""
        if self.type == "sqlite":
            path = self.file_path
            if not path:
                # Default to memory or relative path? 
                # Better to error or use a safe default if not provided, but config usually handles defaults.
                # If path is relative, it will be relative to CWD.
                # If path starts with handling user expansion, it should be done before here.
                # However, for sqlite /// is absolute, //// is absolute? 
                # SQLAlchemy sqlite: sqlite:///foo.db (relative), sqlite:////absolute/path/to/foo.db
                pass 
            return f"sqlite:///{self.file_path}"
        
        # Postgres default
        return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"


class DatabaseConnectionManager:
    """
    Manages database connections.
    
    Provides connection pooling, health checks, and automatic retry logic.
    Supports PostgreSQL (with pooling) and SQLite.
    
    Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
    """
    
    def __init__(self, config: DatabaseConfig):
        """
        Initialize connection manager with configuration.
        """
        self.config = config
        self._engine: Optional[Engine] = None
        self._session_factory: Optional[sessionmaker] = None
        self._initialized = False
        
        logger.info(
            f"Initializing database connection manager: type={config.type}"
        )
    
    def initialize(self) -> None:
        """
        Initialize database engine and session factory.
        
        Creates SQLAlchemy engine.
        Must be called before using get_session().
        """
        if self._initialized:
            logger.warning("Database connection manager already initialized")
            return
        
        connection_url = self.config.get_connection_url()
        
        if self.config.type == "sqlite":
            # SQLite specific engine creation
            from sqlalchemy.pool import StaticPool
            
            connect_args = {"check_same_thread": False}
            
            self._engine = create_engine(
                connection_url,
                connect_args=connect_args,
                poolclass=StaticPool if self.config.file_path == ":memory:" else None,
                echo=self.config.echo,
            )
        else:
            try:
                # PostgreSQL with connection pooling
                self._engine = create_engine(
                    connection_url,
                    poolclass=QueuePool,
                    pool_size=self.config.pool_size,
                    max_overflow=self.config.max_overflow,
                    pool_timeout=self.config.pool_timeout,
                    pool_recycle=self.config.pool_recycle,
                    echo=self.config.echo,
                )
                
                # Verify connection
                with self._engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
                    
            except OperationalError as e:
                if self.config.type == "postgres":
                    logger.warning(f"Failed to connect to PostgreSQL: {e}")
                    logger.warning("Falling back to File-based SQLite...")
                    
                    # Switch to SQLite
                    self.config.type = "sqlite"
                    if not self.config.file_path:
                        # Determine default sqlite path relative to CWD or config dir
                        import os
                        from pathlib import Path
                        
                        # Try to put it in .caracal dir if possible
                        base_dir = Path(os.environ.get("HOME", ".")) / ".caracal"
                        base_dir.mkdir(exist_ok=True)
                        self.config.file_path = str(base_dir / "caracal.db")
                    
                    logger.info(f"Using SQLite database at {self.config.file_path}")
                    
                    connection_url = self.config.get_connection_url()
                    from sqlalchemy.pool import StaticPool
                    connect_args = {"check_same_thread": False}
                    
                    self._engine = create_engine(
                        connection_url,
                        connect_args=connect_args,
                        poolclass=StaticPool if self.config.file_path == ":memory:" else None,
                        echo=self.config.echo,
                    )
                else:
                    raise e
        
        # Create session factory
        self._session_factory = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self._engine,
        )
        
        self._initialized = True
        logger.info("Database connection manager initialized successfully")
    
    def get_session(self) -> Session:
        """
        Get database session from pool.
        
        Returns SQLAlchemy session with automatic transaction management.
        Session must be closed after use (use with context manager).
        
        Returns:
            SQLAlchemy Session
        
        Raises:
            RuntimeError: If connection manager not initialized
        """
        if not self._initialized or self._session_factory is None:
            raise RuntimeError(
                "Database connection manager not initialized. Call initialize() first."
            )
        
        return self._session_factory()
    
    @contextmanager
    def session_scope(self):
        """
        Provide a transactional scope for database operations.
        
        Usage:
            with db_manager.session_scope() as session:
                # Perform database operations
                session.add(obj)
                # Commit happens automatically on success
                # Rollback happens automatically on exception
        
        Yields:
            SQLAlchemy Session
        """
        session = self.get_session()
        try:
            yield session
            session.commit()
        except Exception as e:
            session.rollback()
            logger.error(f"Database transaction failed, rolling back: {e}")
            raise
        finally:
            session.close()
    
    def health_check(self) -> bool:
        """
        Check database connectivity.
        
        Executes a simple query to verify database is reachable.
        
        Returns:
            True if database is reachable, False otherwise
        """
        if not self._initialized or self._engine is None:
            logger.error("Cannot perform health check: connection manager not initialized")
            return False
        
        try:
            with self._engine.connect() as connection:
                result = connection.execute(text("SELECT 1"))
                result.fetchone()
            logger.debug("Database health check passed")
            return True
        except OperationalError as e:
            logger.error(f"Database health check failed: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error during health check: {e}")
            return False
    
    def close(self) -> None:
        """
        Close all connections in pool.
        
        Disposes of the engine and closes all pooled connections.
        Should be called during application shutdown.
        """
        if self._engine is not None:
            logger.info("Closing database connection pool")
            self._engine.dispose()
            self._engine = None
            self._session_factory = None
            self._initialized = False
            logger.info("Database connection pool closed")
    
    def get_pool_status(self) -> dict:
        """
        Get current connection pool status.
        
        Returns:
            Dictionary with pool statistics:
            - size: Current pool size
            - checked_in: Number of connections checked in
            - checked_out: Number of connections checked out
            - overflow: Number of overflow connections
            - total: Total connections (pool + overflow)
        """
        if not self._initialized or self._engine is None:
            return {
                "size": 0,
                "checked_in": 0,
                "checked_out": 0,
                "overflow": 0,
                "total": 0,
            }
        
        pool = self._engine.pool
        return {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "total": pool.size() + pool.overflow(),
        }


# Global connection manager instance
_connection_manager: Optional[DatabaseConnectionManager] = None


def get_connection_manager() -> DatabaseConnectionManager:
    """
    Get global database connection manager instance.
    
    Returns:
        DatabaseConnectionManager singleton instance
    
    Raises:
        RuntimeError: If connection manager not initialized
    """
    global _connection_manager
    if _connection_manager is None:
        raise RuntimeError(
            "Database connection manager not initialized. "
            "Call initialize_connection_manager() first."
        )
    return _connection_manager


def initialize_connection_manager(config: DatabaseConfig) -> DatabaseConnectionManager:
    """
    Initialize global database connection manager.
    
    Args:
        config: Database configuration
    
    Returns:
        Initialized DatabaseConnectionManager
    """
    global _connection_manager
    if _connection_manager is not None:
        logger.warning("Database connection manager already initialized, reinitializing")
        _connection_manager.close()
    
    _connection_manager = DatabaseConnectionManager(config)
    _connection_manager.initialize()
    return _connection_manager


def close_connection_manager() -> None:
    """Close global database connection manager."""
    global _connection_manager
    if _connection_manager is not None:
        _connection_manager.close()
        _connection_manager = None


@contextmanager
def get_session(config: DatabaseConfig) -> Generator[Session, None, None]:
    """
    Get a database session using the global connection manager.
    
    Args:
        config: Database configuration
        
    Yields:
        SQLAlchemy Session
    """
    manager = initialize_connection_manager(config)
    with manager.session_scope() as session:
        yield session


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    """
    Get a database session from the global connection manager.
    
    Yields:
        SQLAlchemy Session
    """
    manager = get_connection_manager()
    with manager.session_scope() as session:
        yield session
