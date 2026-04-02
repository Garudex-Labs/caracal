"""Simple test to verify pytest works."""
import pytest


@pytest.mark.unit
def test_simple_pass():
    """Test that always passes."""
    assert True


@pytest.mark.unit
def test_simple_math():
    """Test basic math."""
    assert 1 + 1 == 2
