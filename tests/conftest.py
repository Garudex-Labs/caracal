"""
Global pytest configuration and fixtures.

This module provides shared fixtures and configuration for all tests.
"""
import os
import pytest

pytest_plugins = ["tests.fixtures"]


# ============================================================================
# Environment Setup
# ============================================================================

@pytest.fixture(scope="session", autouse=True)
def setup_test_environment():
    """Set up test environment variables."""
    os.environ["CCL_ENV"] = "test"
    os.environ["CCL_LOG_LEVEL"] = "ERROR"
    yield
    # Cleanup after all tests
    os.environ.pop("CCL_ENV", None)
    os.environ.pop("CCL_LOG_LEVEL", None)


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
