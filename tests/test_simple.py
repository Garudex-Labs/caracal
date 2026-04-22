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


@pytest.mark.unit
def test_import_caracal():
    """Test that caracal namespace package can be imported and exposes a version."""
    import caracal
    from caracal._version import __version__
    assert caracal is not None
    assert isinstance(__version__, str) and __version__


@pytest.mark.unit
def test_caracal_version():
    """Test that caracal version is accessible."""
    from caracal._version import __version__
    assert __version__ is not None
    assert isinstance(__version__, str)
    assert len(__version__) > 0
