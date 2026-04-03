"""Database test fixtures."""
import pytest
import os
from typing import Generator
from sqlalchemy import BigInteger, create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from caracal.db.models import Base


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(_type, _compiler, **_kwargs):
    """Map PostgreSQL JSONB columns to JSON for SQLite-based tests."""
    return "JSON"


@compiles(BigInteger, "sqlite")
def _compile_bigint_sqlite(_type, _compiler, **_kwargs):
    """Map BigInteger PKs to INTEGER so SQLite autoincrement works."""
    return "INTEGER"


@pytest.fixture
def test_db_url() -> str:
    """Provide test database URL from environment or default to in-memory SQLite."""
    # Check for test database URL in environment
    test_url = os.environ.get("CARACAL_TEST_DB_URL")
    if test_url:
        return test_url
    # Default to in-memory SQLite for unit tests
    return "sqlite:///:memory:"


@pytest.fixture
def in_memory_db_engine():
    """Provide an in-memory database engine for testing."""
    test_db_url = os.environ.get("CARACAL_TEST_DB_URL", "sqlite:///:memory:")

    # For SQLite, use special configuration
    if test_db_url.startswith("sqlite"):
        engine = create_engine(
            test_db_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        # Enable foreign keys for SQLite
        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_conn, connection_record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    else:
        # For PostgreSQL test database
        engine = create_engine(test_db_url)
    
    # Create all tables
    Base.metadata.create_all(engine)
    
    yield engine
    
    # Cleanup: drop all tables
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def db_session(in_memory_db_engine) -> Generator[Session, None, None]:
    """Provide a database session for testing with automatic rollback."""
    SessionLocal = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=in_memory_db_engine,
    )
    
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def db_connection(in_memory_db_engine):
    """Provide a database connection for testing."""
    connection = in_memory_db_engine.connect()
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture
def test_database_url() -> str:
    """Provide a test database URL for PostgreSQL integration tests."""
    return os.environ.get(
        "CARACAL_TEST_DB_URL",
        "postgresql://test:test@localhost:5432/caracal_test"
    )


@pytest.fixture
def migration_versions() -> list[str]:
    """Provide test migration version identifiers."""
    return [
        "001_initial_schema",
        "002_add_authority_metadata",
        "003_add_delegation_constraints",
        "004_add_audit_log",
        "005_add_merkle_tree",
    ]


@pytest.fixture
def clean_database(db_session):
    """Ensure database is clean before and after test."""
    # Clean before test
    for table in reversed(Base.metadata.sorted_tables):
        db_session.execute(table.delete())
    db_session.commit()
    
    yield db_session
    
    # Clean after test
    for table in reversed(Base.metadata.sorted_tables):
        db_session.execute(table.delete())
    db_session.commit()

