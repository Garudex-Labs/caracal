"""Database test fixtures."""
import pytest
import os
from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from caracal.db.models import Base


@pytest.fixture
def test_db_url() -> str:
    """Provide PostgreSQL test database URL."""
    # Check for test database URL in environment
    test_url = os.environ.get("CARACAL_TEST_DB_URL")
    if test_url:
        return test_url
    return "postgresql://caracal:caracal@localhost:5432/caracal_test"


@pytest.fixture
def in_memory_db_engine():
    """Provide a PostgreSQL database engine for testing."""
    test_db_url = os.environ.get(
        "CARACAL_TEST_DB_URL",
        "postgresql://caracal:caracal@localhost:5432/caracal_test",
    )
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

