"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Database connection management for Caracal Core.

PostgreSQL is the **only** supported database backend.  There is no SQLite
fallback — if PostgreSQL is not reachable the application must fail loudly
so the operator can fix the infrastructure.

Configuration is resolved in this priority order:
  1. Explicit ``DatabaseConfig`` values passed at construction time.
  2. Environment variables (``CARACAL_DB_HOST``, ``CARACAL_DB_PORT``, etc.).
  3. Workspace ``config.yaml`` (via ``get_db_manager()``).

"""

import logging
import os
import re
from contextlib import contextmanager
from typing import Optional, Generator
from urllib.parse import quote_plus

from sqlalchemy import create_engine, event as sa_event, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import QueuePool

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Environment variable names (all optional — override config.yaml values)
# ---------------------------------------------------------------------------
_ENV_PREFIX = "CARACAL_DB_"
_ENV_HOST = f"{_ENV_PREFIX}HOST"          # default: localhost
_ENV_PORT = f"{_ENV_PREFIX}PORT"          # default: 5432
_ENV_NAME = f"{_ENV_PREFIX}NAME"          # default: caracal
_ENV_USER = f"{_ENV_PREFIX}USER"          # default: caracal
_ENV_PASSWORD = f"{_ENV_PREFIX}PASSWORD"  # default: ""
_ENV_SCHEMA = f"{_ENV_PREFIX}SCHEMA"      # default: "" (public)


def _env(name: str, fallback: str = "") -> str:
    """Read an environment variable, returning *fallback* when unset/empty.

    Checks ``CARACAL_DB_*`` first, then falls back to the shorter ``DB_*``
    prefix (used by docker-compose / .env files) for convenience.
    """
    value = os.environ.get(name, "")
    if value:
        return value
    # Try the shorter DB_* prefix (e.g. CARACAL_DB_PASSWORD -> DB_PASSWORD)
    if name.startswith(_ENV_PREFIX):
        short = "DB_" + name[len(_ENV_PREFIX):]
        value = os.environ.get(short, "")
        if value:
            return value
    return fallback


def _ensure_dotenv_loaded() -> None:
    """Load the nearest ``.env`` file into ``os.environ`` once.

    Uses ``python-dotenv`` if available.  Values already set in the
    environment are NOT overwritten (``override=False``).
    """
    if getattr(_ensure_dotenv_loaded, "_done", False):
        return
    _ensure_dotenv_loaded._done = True  # type: ignore[attr-defined]
    try:
        from dotenv import load_dotenv
        load_dotenv(override=False)
    except ImportError:
        pass


class DatabaseConfig:
    """PostgreSQL-only database configuration.

    Values can be overridden individually via ``CARACAL_DB_*`` environment
    variables.  Environment variables take precedence over constructor
    arguments when set.
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 5432,
        database: str = "caracal",
        user: str = "caracal",
        password: str = "",
        schema: str = "",
        pool_size: int = 10,
        max_overflow: int = 5,
        pool_timeout: int = 30,
        pool_recycle: int = 3600,
        echo: bool = False,
        # Legacy kwargs accepted but ignored — prevents breakage in callers
        # that still pass type= or file_path=.
        **_ignored,
    ):
        _ensure_dotenv_loaded()
        self.host = _env(_ENV_HOST, host)
        self.port = int(_env(_ENV_PORT, str(port)))
        self.database = _env(_ENV_NAME, database)
        self.user = _env(_ENV_USER, user)
        self.password = _env(_ENV_PASSWORD, password)
        self.schema = _env(_ENV_SCHEMA, schema)
        self.pool_size = pool_size
        self.max_overflow = max_overflow
        self.pool_timeout = pool_timeout
        self.pool_recycle = pool_recycle
        self.echo = echo

    # Back-compat: callers that still check config.type
    @property
    def type(self) -> str:
        return "postgresql"

    def get_connection_url(self) -> str:
        """Build a ``postgresql://`` connection URL."""
        return (
            f"postgresql://{self.user}:{quote_plus(self.password)}"
            f"@{self.host}:{self.port}/{self.database}"
        )


class DatabaseConnectionManager:
    """
    Manages PostgreSQL connections with pooling and workspace schema isolation.

    """

    def __init__(self, config: DatabaseConfig):
        self.config = config
        self._engine: Optional[Engine] = None
        self._session_factory: Optional[sessionmaker] = None
        self._initialized = False
        self._pg_schema: Optional[str] = None  # workspace schema name
        logger.info("Initializing database connection manager (PostgreSQL)")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def initialize(self) -> None:
        """Create the SQLAlchemy engine, verify connectivity, and ensure
        the workspace schema + tables exist.

        Raises ``RuntimeError`` if PostgreSQL is unreachable.
        """
        if self._initialized:
            logger.warning("Database connection manager already initialized")
            return

        connection_url = self.config.get_connection_url()

        # Validate optional workspace schema name
        pg_schema: Optional[str] = None
        if self.config.schema:
            schema = self.config.schema
            if not re.match(r'^[a-z_][a-z0-9_]{0,62}$', schema):
                raise ValueError(f"Invalid PostgreSQL schema name: {schema!r}")
            pg_schema = schema

        # Build engine with connection pooling
        engine_kwargs = dict(
            poolclass=QueuePool,
            pool_size=self.config.pool_size,
            max_overflow=self.config.max_overflow,
            pool_timeout=self.config.pool_timeout,
            pool_recycle=self.config.pool_recycle,
            echo=self.config.echo,
        )

        self._engine = create_engine(connection_url, **engine_kwargs)

        # If workspace schema is set, transparently route all queries there
        if pg_schema:
            @sa_event.listens_for(self._engine, "connect")
            def _set_search_path(dbapi_conn, connection_record):
                cursor = dbapi_conn.cursor()
                cursor.execute(f"SET search_path TO {pg_schema}, public")
                cursor.close()
                dbapi_conn.commit()

        # Verify connection — fail hard, no fallback
        try:
            with self._engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            logger.info(
                "Connected to PostgreSQL: %s@%s:%s/%s",
                self.config.user, self.config.host,
                self.config.port, self.config.database,
            )
        except OperationalError as e:
            logger.error("PostgreSQL connection failed: %s", e)
            raise RuntimeError(
                f"PostgreSQL connection failed: {e}\n"
                f"Fix your PostgreSQL server or credentials. "
                f"There is no fallback database."
            ) from e

        # Ensure workspace schema exists
        if pg_schema:
            try:
                with self._engine.connect() as conn:
                    conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {pg_schema}"))
                    conn.commit()
                logger.info("PostgreSQL schema ensured: %s", pg_schema)
            except Exception as e:
                logger.warning("Could not create schema '%s': %s", pg_schema, e)
        
        # Create session factory
        self._session_factory = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self._engine,
        )

        # Store schema for later use (drop_schema, clear_database)
        self._pg_schema = pg_schema

        # Create tables inside the workspace schema using schema_translate_map
        # This tells SQLAlchemy to map None (default/public) -> workspace schema
        # for all DDL operations, ensuring tables live in ws_<name> not public.
        try:
            from caracal.db.models import Base
            if pg_schema:
                schema_engine = self._engine.execution_options(
                    schema_translate_map={None: pg_schema}
                )
                Base.metadata.create_all(schema_engine)
            else:
                Base.metadata.create_all(self._engine)
            logger.info("Database tables verified/created")
        except Exception as e:
            logger.warning("Could not create tables automatically: %s", e)

        self._initialized = True
        logger.info("Database connection manager initialized successfully")

    # ------------------------------------------------------------------
    # Session helpers
    # ------------------------------------------------------------------

    def get_session(self) -> Session:
        """Return a new SQLAlchemy ``Session``.  Must ``close()`` after use."""
        if not self._initialized or self._session_factory is None:
            raise RuntimeError(
                "Database connection manager not initialized. Call initialize() first."
            )
        return self._session_factory()

    @contextmanager
    def session_scope(self):
        """Transactional scope — auto-commits on success, rolls back on error."""
        session = self.get_session()
        try:
            yield session
            session.commit()
        except Exception as e:
            session.rollback()
            logger.error("Database transaction failed, rolling back: %s", e)
            raise
        finally:
            session.close()

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def health_check(self) -> bool:
        """Return ``True`` if the database is reachable."""
        if not self._initialized or self._engine is None:
            return False
        try:
            with self._engine.connect() as conn:
                conn.execute(text("SELECT 1")).fetchone()
            return True
        except Exception as e:
            logger.error("Database health check failed: %s", e)
            return False

    def get_pool_status(self) -> dict:
        """Return connection pool statistics."""
        if not self._initialized or self._engine is None:
            return {"size": 0, "checked_in": 0, "checked_out": 0, "overflow": 0, "total": 0}
        pool = self._engine.pool
        return {
            "size": pool.size(),
            "checked_in": pool.checkedin(),
            "checked_out": pool.checkedout(),
            "overflow": pool.overflow(),
            "total": pool.size() + pool.overflow(),
        }

    # ------------------------------------------------------------------
    # Destructive operations
    # ------------------------------------------------------------------

    def clear_database(self) -> None:
        """Drop and recreate all tables.  **Destroys all data.**"""
        if not self._initialized or self._engine is None:
            raise RuntimeError("Not initialized.")
        logger.warning("Clearing database — dropping all tables")
        from caracal.db.models import Base
        if self._pg_schema:
            schema_engine = self._engine.execution_options(
                schema_translate_map={None: self._pg_schema}
            )
            Base.metadata.drop_all(schema_engine)
            Base.metadata.create_all(schema_engine)
        else:
            Base.metadata.drop_all(self._engine)
            Base.metadata.create_all(self._engine)
        logger.info("All tables recreated — database is empty")

    def drop_schema(self, schema_name: str | None = None) -> None:
        """Drop the workspace schema and everything in it.

        Called when a workspace is being permanently deleted.  Has no
        effect when no schema is configured (tables live in ``public``).

        Args:
            schema_name: Explicit schema to drop.  Falls back to
                         ``self.config.schema`` when omitted.
        """
        schema = schema_name or self.config.schema
        if not schema:
            logger.info("No workspace schema configured — nothing to drop")
            return
        if not re.match(r'^[a-z_][a-z0-9_]{0,62}$', schema):
            raise ValueError(f"Invalid PostgreSQL schema name: {schema!r}")
        if not self._initialized or self._engine is None:
            raise RuntimeError("Not initialized.")
        logger.warning("Dropping PostgreSQL schema: %s", schema)
        with self._engine.connect() as conn:
            conn.execute(text(f"DROP SCHEMA IF EXISTS {schema} CASCADE"))
            conn.commit()
        logger.info("Schema '%s' dropped", schema)

    def close(self) -> None:
        """Dispose of engine and close all pooled connections."""
        if self._engine is not None:
            logger.info("Closing database connection pool")
            self._engine.dispose()
            self._engine = None
            self._session_factory = None
            self._initialized = False


# ======================================================================
# Global / singleton helpers
# ======================================================================

_connection_manager: Optional[DatabaseConnectionManager] = None


def get_connection_manager() -> DatabaseConnectionManager:
    """Return the global ``DatabaseConnectionManager`` (must be initialized)."""
    global _connection_manager
    if _connection_manager is None:
        raise RuntimeError("Call initialize_connection_manager() first.")
    return _connection_manager


def initialize_connection_manager(config: DatabaseConfig) -> DatabaseConnectionManager:
    """Initialize (or reinitialize) the global connection manager."""
    global _connection_manager
    if _connection_manager is not None:
        _connection_manager.close()
    _connection_manager = DatabaseConnectionManager(config)
    _connection_manager.initialize()
    return _connection_manager


def close_connection_manager() -> None:
    """Close the global connection manager."""
    global _connection_manager
    if _connection_manager is not None:
        _connection_manager.close()
        _connection_manager = None


@contextmanager
def get_session(config: DatabaseConfig) -> Generator[Session, None, None]:
    """Convenience: initialize a manager and yield a session."""
    manager = initialize_connection_manager(config)
    with manager.session_scope() as session:
        yield session


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    """Yield a session from the global connection manager."""
    manager = get_connection_manager()
    with manager.session_scope() as session:
        yield session


def get_db_manager() -> DatabaseConnectionManager:
    """Create and initialize a ``DatabaseConnectionManager`` from the active
    workspace ``config.yaml``.

    This is the **single canonical helper** that all TUI flow screens and
    CLI commands should use instead of manually constructing a
    ``DatabaseConfig``.

    Environment variables (``CARACAL_DB_*``) take highest precedence,
    followed by the YAML config values.
    """
    from caracal.config import load_config

    config = load_config()

    db_config = DatabaseConfig(
        host=getattr(config.database, "host", "localhost"),
        port=int(getattr(config.database, "port", 5432)),
        database=getattr(config.database, "database", "caracal"),
        user=getattr(config.database, "user", "caracal"),
        password=getattr(config.database, "password", ""),
        schema=getattr(config.database, "schema", ""),
        pool_size=getattr(config.database, "pool_size", 10),
        max_overflow=getattr(config.database, "max_overflow", 5),
        pool_timeout=getattr(config.database, "pool_timeout", 30),
    )

    manager = DatabaseConnectionManager(db_config)
    manager.initialize()
    return manager
