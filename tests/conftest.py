"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Global pytest configuration and shared fixtures for the Caracal test suite.
"""
import os
import pytest

pytest_plugins = ["tests.mock"]


@pytest.fixture(scope="session", autouse=True)
def setup_test_environment():
    """Set up test environment variables for the entire session."""
    os.environ["CARACAL_ENV"] = "test"
    os.environ["CARACAL_LOG_LEVEL"] = "ERROR"
    yield
    os.environ.pop("CARACAL_ENV", None)
    os.environ.pop("CARACAL_LOG_LEVEL", None)


def pytest_configure(config):
    """Register custom markers."""
    markers = [
        "unit: Unit tests — isolated component testing",
        "integration: Integration tests — multi-component interactions",
        "security: Security tests — abuse, fuzzing, and boundary checks",
        "edge: Edge case tests — boundary values and unusual inputs",
        "regression: Regression tests — guards against previously fixed bugs",
        "coverage: Coverage tests — targets specific uncovered paths",
        "property: Property-based tests using Hypothesis",
        "slow: Slow-running tests (marked for optional skipping)",
    ]
    for marker in markers:
        config.addinivalue_line("markers", marker)


def pytest_collection_modifyitems(config, items):
    """Auto-assign markers based on test file location."""
    location_markers = {
        "/unit/": "unit",
        "/integration/": "integration",
        "/security/": "security",
        "/edge/": "edge",
        "/regression/": "regression",
        "/coverage/": "coverage",
    }
    for item in items:
        path = str(item.fspath)
        for fragment, marker in location_markers.items():
            if fragment in path:
                item.add_marker(getattr(pytest.mark, marker))
                break
