"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Database fixtures for integration and unit tests.
"""
import os
from typing import Generator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker


def _load_base_model():
    """Load SQLAlchemy base model for fixture-driven table setup."""
    try:
        from caracal.db.models import Base
    except ModuleNotFoundError as exc:
        if exc.name != "caracal.db.models":
            raise
        pytest.skip(
            "Database fixtures require caracal-server imports. "
            "Run `uv sync --group dev` and use `uv run pytest`: "
            f"{exc}"
        )
    return Base


@pytest.fixture
def in_memory_db_engine():
    """Provide a PostgreSQL database engine for testing."""
    base_model = _load_base_model()
    test_db_url = os.environ.get(
        "CCL_TEST_DB_URL",
        "postgresql://caracal:caracal@localhost:5432/caracal_test",
    )
    engine = create_engine(
        test_db_url,
        connect_args={"connect_timeout": 3},
    )
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:
        engine.dispose()
        pytest.skip(
            "PostgreSQL test database unavailable (start `caracal up` or set "
            f"CCL_TEST_DB_URL): {exc}"
        )

    # Create all tables
    base_model.metadata.create_all(engine)
    
    yield engine
    
    # Cleanup: drop all tables
    base_model.metadata.drop_all(engine)
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
