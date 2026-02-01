"""
Pytest configuration and shared fixtures for Caracal Core tests.
"""

import os
import tempfile
from pathlib import Path
from typing import Generator

import pytest


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
def sample_config_path(temp_dir: Path) -> Path:
    """
    Create a sample configuration file for testing.
    
    Args:
        temp_dir: Temporary directory fixture.
        
    Returns:
        Path to sample config file.
    """
    config_path = temp_dir / "config.yaml"
    config_content = """
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {temp_dir}/pricebook.csv
  backup_dir: {temp_dir}/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily

logging:
  level: INFO
  file: {temp_dir}/caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
""".format(temp_dir=temp_dir)
    
    config_path.write_text(config_content)
    return config_path


@pytest.fixture
def sample_pricebook_path(temp_dir: Path) -> Path:
    """
    Create a sample pricebook CSV file for testing.
    
    Args:
        temp_dir: Temporary directory fixture.
        
    Returns:
        Path to sample pricebook file.
    """
    pricebook_path = temp_dir / "pricebook.csv"
    pricebook_content = """resource_type,price_per_unit,currency,updated_at
openai.gpt4.input_tokens,0.000030,USD,2024-01-15T10:00:00Z
openai.gpt4.output_tokens,0.000060,USD,2024-01-15T10:00:00Z
anthropic.claude3.input_tokens,0.000015,USD,2024-01-15T10:00:00Z
anthropic.claude3.output_tokens,0.000075,USD,2024-01-15T10:00:00Z
"""
    pricebook_path.write_text(pricebook_content)
    return pricebook_path


# Hypothesis settings for property-based tests
from hypothesis import settings, Verbosity

# Register custom profile for Caracal tests
settings.register_profile("caracal", max_examples=100, verbosity=Verbosity.normal)
settings.register_profile("caracal-ci", max_examples=1000, verbosity=Verbosity.verbose)
settings.register_profile("caracal-dev", max_examples=10, verbosity=Verbosity.verbose)

# Load profile from environment or use default
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "caracal"))
