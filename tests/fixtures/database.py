"""Database test fixtures."""
import pytest
import os
from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from caracal.db.models import Base


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
