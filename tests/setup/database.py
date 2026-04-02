"""Database setup utilities for testing."""
import os
from typing import Optional
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker


def get_test_database_url() -> str:
    """Get test database URL from environment or use default."""
    return os.getenv(
        "TEST_DATABASE_URL",
        "postgresql://test:test@localhost:5432/caracal_test"
    )


def create_test_engine(database_url: Optional[str] = None):
    """Create a test database engine."""
    url = database_url or get_test_database_url()
    return create_engine(url, echo=False)


def create_test_session(engine):
    """Create a test database session."""
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return SessionLocal()


def setup_test_database(engine):
    """Set up test database schema."""
    # This would typically run migrations or create tables
    # For now, it's a placeholder
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        conn.commit()


def teardown_test_database(engine):
    """Tear down test database."""
    # Clean up test data
    with engine.connect() as conn:
        # Drop all tables or truncate data
        conn.execute(text("SELECT 1"))
        conn.commit()


def reset_test_database(engine):
    """Reset test database to clean state."""
    teardown_test_database(engine)
    setup_test_database(engine)
