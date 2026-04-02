"""
Global pytest configuration and fixtures.

This module provides shared fixtures and configuration for all tests.
"""
import os
import pytest
from typing import Generator
from unittest.mock import Mock


# ============================================================================
# Environment Setup
# ============================================================================

@pytest.fixture(scope="session", autouse=True)
def setup_test_environment():
    """Set up test environment variables."""
    os.environ["CARACAL_ENV"] = "test"
    os.environ["CARACAL_LOG_LEVEL"] = "ERROR"
    yield
    # Cleanup after all tests
    os.environ.pop("CARACAL_ENV", None)
    os.environ.pop("CARACAL_LOG_LEVEL", None)


# ============================================================================
# Database Fixtures
# ============================================================================

@pytest.fixture
def mock_db_session():
    """Provide a mock database session."""
    session = Mock()
    session.commit = Mock()
    session.rollback = Mock()
    session.close = Mock()
    return session


@pytest.fixture
def mock_db_connection():
    """Provide a mock database connection."""
    connection = Mock()
    connection.execute = Mock()
    connection.close = Mock()
    return connection


# ============================================================================
# Redis Fixtures
# ============================================================================

@pytest.fixture
def mock_redis_client():
    """Provide a mock Redis client."""
    client = Mock()
    client.get = Mock(return_value=None)
    client.set = Mock(return_value=True)
    client.delete = Mock(return_value=1)
    client.exists = Mock(return_value=False)
    return client


# ============================================================================
# HTTP Client Fixtures
# ============================================================================

@pytest.fixture
def mock_http_client():
    """Provide a mock HTTP client."""
    client = Mock()
    client.get = Mock()
    client.post = Mock()
    client.put = Mock()
    client.delete = Mock()
    return client


# ============================================================================
# Cryptographic Fixtures
# ============================================================================

@pytest.fixture
def mock_keypair():
    """Provide a mock cryptographic keypair."""
    return {
        "private_key": "mock_private_key_data",
        "public_key": "mock_public_key_data"
    }


# ============================================================================
# Test Data Fixtures
# ============================================================================

@pytest.fixture
def sample_authority_data():
    """Provide sample authority data for testing."""
    return {
        "id": "auth-test-001",
        "name": "test-authority",
        "scope": "read:secrets",
        "created_at": "2024-01-01T00:00:00Z"
    }


@pytest.fixture
def sample_mandate_data():
    """Provide sample mandate data for testing."""
    return {
        "id": "mandate-test-001",
        "authority_id": "auth-test-001",
        "principal_id": "user-test-001",
        "scope": "read:secrets",
        "status": "active",
        "created_at": "2024-01-01T00:00:00Z"
    }


@pytest.fixture
def sample_delegation_data():
    """Provide sample delegation data for testing."""
    return {
        "id": "delegation-test-001",
        "from_principal": "user-test-001",
        "to_principal": "user-test-002",
        "scope": "read:secrets",
        "created_at": "2024-01-01T00:00:00Z"
    }


# ============================================================================
# Pytest Hooks
# ============================================================================

def pytest_configure(config):
    """Configure pytest with custom markers and settings."""
    config.addinivalue_line(
        "markers", "unit: Unit tests (isolated component testing)"
    )
    config.addinivalue_line(
        "markers", "integration: Integration tests (multi-component)"
    )
    config.addinivalue_line(
        "markers", "e2e: End-to-end tests (full system)"
    )
    config.addinivalue_line(
        "markers", "security: Security-focused tests"
    )
    config.addinivalue_line(
        "markers", "property: Property-based tests"
    )
    config.addinivalue_line(
        "markers", "slow: Slow-running tests"
    )


def pytest_collection_modifyitems(config, items):
    """Modify test collection to add markers based on test location."""
    for item in items:
        # Add markers based on test file path
        if "unit" in str(item.fspath):
            item.add_marker(pytest.mark.unit)
        elif "integration" in str(item.fspath):
            item.add_marker(pytest.mark.integration)
        elif "e2e" in str(item.fspath):
            item.add_marker(pytest.mark.e2e)
        elif "security" in str(item.fspath):
            item.add_marker(pytest.mark.security)
