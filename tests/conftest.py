"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pytest configuration and shared fixtures for Caracal Core tests.
"""

import os
import tempfile
from pathlib import Path
from typing import Generator, Optional

import pytest


# Global test key path (created once per session for efficiency)
_TEST_KEY_PATH: Optional[Path] = None


def _create_test_ecdsa_key(directory: Path) -> Path:
    """
    Create a test ECDSA private key for merkle signing.
    
    Args:
        directory: Directory to create the key in.
        
    Returns:
        Path to test private key file (PEM format).
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
    
    # Generate a test ECDSA key pair
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    
    # Serialize private key to PEM
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption()
    )
    
    key_path = directory / "test_signing_key.pem"
    key_path.write_bytes(private_pem)
    
    return key_path


def get_test_merkle_key_path() -> Path:
    """
    Get or create a session-scoped test merkle key.
    
    Returns:
        Path to test signing key.
    """
    global _TEST_KEY_PATH
    if _TEST_KEY_PATH is None or not _TEST_KEY_PATH.exists():
        # Create in a temp directory that persists for the session
        import tempfile
        temp_dir = Path(tempfile.mkdtemp(prefix="caracal_test_"))
        _TEST_KEY_PATH = _create_test_ecdsa_key(temp_dir)
    return _TEST_KEY_PATH


def create_test_config_content(
    temp_dir: Path,
    merkle_key_path: Optional[Path] = None,
    **overrides
) -> str:
    """
    Generate test configuration YAML content with proper merkle settings.
    
    This helper ensures all test configs have valid merkle configuration
    to pass validation.
    
    Args:
        temp_dir: Temporary directory for storage paths.
        merkle_key_path: Optional path to merkle key. If None, uses session key.
        **overrides: Additional config sections to override.
        
    Returns:
        YAML configuration content as string.
    """
    if merkle_key_path is None:
        merkle_key_path = get_test_merkle_key_path()
    
    config = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  backup_dir: {temp_dir}/backups
  backup_count: 3

defaults:
  time_window: daily

logging:
  level: INFO
  file: {temp_dir}/caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

merkle:
  signing_backend: software
  private_key_path: {merkle_key_path}
"""
    return config


@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    """
    Create a temporary directory for test files.
    
    Yields:
        Path to temporary directory that is cleaned up after test.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def test_data_dir() -> Path:
    """
    Get path to test data directory.
    
    Returns:
        Path to tests/data directory.
    """
    return Path(__file__).parent / "data"


@pytest.fixture
def test_merkle_key(temp_dir: Path) -> Path:
    """
    Create a test ECDSA private key for merkle signing.
    
    Args:
        temp_dir: Temporary directory fixture.
        
    Returns:
        Path to test private key file (PEM format).
    """
    return _create_test_ecdsa_key(temp_dir)


@pytest.fixture
def sample_config_path(temp_dir: Path, test_merkle_key: Path) -> Path:
    """
    Create a sample configuration file for testing.
    
    Args:
        temp_dir: Temporary directory fixture.
        test_merkle_key: Path to test merkle signing key.
        
    Returns:
        Path to sample config file.
    """
    config_path = temp_dir / "config.yaml"
    config_content = create_test_config_content(
        temp_dir=temp_dir, 
        merkle_key_path=test_merkle_key
    )
    config_path.write_text(config_content)
    return config_path


@pytest.fixture
def make_config_yaml(temp_dir: Path, test_merkle_key: Path):
    """
    Factory fixture that creates test config content with proper merkle settings.
    
    Returns a callable that tests can use to generate valid config content.
    
    Usage:
        def test_something(temp_dir, make_config_yaml):
            config_content = make_config_yaml()
            config_path = temp_dir / "config.yaml"
            config_path.write_text(config_content)
    """
    def _make_config():
        return create_test_config_content(
            temp_dir=temp_dir,
            merkle_key_path=test_merkle_key
        )
    return _make_config


# Hypothesis settings for property-based tests
from hypothesis import settings, Verbosity

# Register custom profile for Caracal tests
settings.register_profile("caracal", max_examples=100, verbosity=Verbosity.normal)
settings.register_profile("caracal-ci", max_examples=1000, verbosity=Verbosity.verbose)
settings.register_profile("caracal-dev", max_examples=10, verbosity=Verbosity.verbose)

# Load profile from environment or use default
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "caracal"))
