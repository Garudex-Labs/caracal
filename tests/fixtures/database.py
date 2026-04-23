"""Database test fixtures."""
import os
from typing import Generator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from caracal.db.models import Base


@pytest.fixture
def in_memory_db_engine():
    """Provide a PostgreSQL database engine for testing."""
    test_db_url = os.environ.get(
        "CARACAL_TEST_DB_URL",
        "postgresql://caracal:caracal@localhost:5432/caracal_test",
    )
    engine = create_engine(test_db_url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:
        engine.dispose()
        pytest.skip(
            "PostgreSQL test database unavailable (start `caracal up` or set "
            f"CARACAL_TEST_DB_URL): {exc}"
        )

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
