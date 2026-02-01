"""
Unit tests for configuration management.

Tests configuration loading, validation, and default values.
"""

import os
import tempfile
from pathlib import Path

import pytest
import yaml

from caracal.config import (
    CaracalConfig,
    DefaultsConfig,
    LoggingConfig,
    PerformanceConfig,
    StorageConfig,
    get_default_config,
    load_config,
)
from caracal.exceptions import InvalidConfigurationError


class TestDefaultConfiguration:
    """Test default configuration generation."""
    
    def test_get_default_config_returns_valid_config(self):
        """Test that get_default_config returns a valid CaracalConfig object."""
        config = get_default_config()
        
        assert isinstance(config, CaracalConfig)
        assert isinstance(config.storage, StorageConfig)
        assert isinstance(config.defaults, DefaultsConfig)
        assert isinstance(config.logging, LoggingConfig)
        assert isinstance(config.performance, PerformanceConfig)
    
    def test_default_config_has_sensible_values(self):
        """Test that default configuration has sensible values."""
        config = get_default_config()
        
        # Check storage paths
        assert config.storage.agent_registry.endswith("agents.json")
        assert config.storage.policy_store.endswith("policies.json")
        assert config.storage.ledger.endswith("ledger.jsonl")
        assert config.storage.pricebook.endswith("pricebook.csv")
        assert config.storage.backup_dir.endswith("backups")
        assert config.storage.backup_count == 3
        
        # Check defaults
        assert config.defaults.currency == "USD"
        assert config.defaults.time_window == "daily"
        assert config.defaults.default_budget == 100.00
        
        # Check logging
        assert config.logging.level == "INFO"
        assert config.logging.file.endswith("caracal.log")
        
        # Check performance
        assert config.performance.policy_eval_timeout_ms == 100
        assert config.performance.ledger_write_timeout_ms == 10
        assert config.performance.file_lock_timeout_s == 5
        assert config.performance.max_retries == 3


class TestConfigurationLoading:
    """Test configuration loading from YAML files."""
    
    def test_load_config_returns_defaults_when_file_missing(self):
        """Test that load_config returns defaults when config file doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "nonexistent.yaml")
            config = load_config(config_path)
            
            assert isinstance(config, CaracalConfig)
            # Should have default values
            assert config.defaults.currency == "USD"
    
    def test_load_config_from_valid_yaml(self):
        """Test loading configuration from a valid YAML file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Create a valid config file
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                    'backup_count': 5,
                },
                'defaults': {
                    'currency': 'EUR',
                    'time_window': 'daily',
                    'default_budget': 200.00,
                },
                'logging': {
                    'level': 'DEBUG',
                    'file': '/tmp/caracal.log',
                },
                'performance': {
                    'policy_eval_timeout_ms': 200,
                    'max_retries': 5,
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            assert config.storage.agent_registry == '/tmp/agents.json'
            assert config.storage.backup_count == 5
            assert config.defaults.currency == 'EUR'
            assert config.defaults.default_budget == 200.00
            assert config.logging.level == 'DEBUG'
            assert config.performance.policy_eval_timeout_ms == 200
            assert config.performance.max_retries == 5
    
    def test_load_config_merges_with_defaults(self):
        """Test that partial config merges with defaults."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Create a minimal config file (only storage)
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            # Storage should be from file
            assert config.storage.agent_registry == '/tmp/agents.json'
            
            # Defaults should be from default config
            assert config.defaults.currency == 'USD'
            assert config.logging.level == 'INFO'
            assert config.performance.max_retries == 3
    
    def test_load_config_expands_home_directory(self):
        """Test that ~ is expanded to user home directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '~/caracal/agents.json',
                    'policy_store': '~/caracal/policies.json',
                    'ledger': '~/caracal/ledger.jsonl',
                    'pricebook': '~/caracal/pricebook.csv',
                    'backup_dir': '~/caracal/backups',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            # Paths should be expanded
            assert not config.storage.agent_registry.startswith('~')
            assert os.path.expanduser('~') in config.storage.agent_registry


class TestConfigurationValidation:
    """Test configuration validation."""
    
    def test_load_config_rejects_malformed_yaml(self):
        """Test that malformed YAML raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Write malformed YAML
            with open(config_path, 'w') as f:
                f.write("invalid: yaml: content:\n  - broken")
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "Failed to parse YAML" in str(exc_info.value)
    
    def test_load_config_rejects_missing_storage_section(self):
        """Test that missing storage section raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Config without storage section
            config_data = {
                'defaults': {
                    'currency': 'USD',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "Missing required 'storage' section" in str(exc_info.value)
    
    def test_validation_rejects_invalid_time_window(self):
        """Test that invalid time window raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                },
                'defaults': {
                    'time_window': 'hourly',  # Not supported in v0.1
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "time_window must be one of" in str(exc_info.value)
    
    def test_validation_rejects_negative_default_budget(self):
        """Test that negative default budget raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                },
                'defaults': {
                    'default_budget': -10.00,
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "default_budget must be positive" in str(exc_info.value)
    
    def test_validation_rejects_invalid_log_level(self):
        """Test that invalid log level raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                },
                'logging': {
                    'level': 'INVALID',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "logging level must be one of" in str(exc_info.value)
    
    def test_validation_rejects_invalid_backup_count(self):
        """Test that backup count less than 1 raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                    'backup_count': 0,
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "backup_count must be at least 1" in str(exc_info.value)
    
    def test_validation_rejects_negative_timeouts(self):
        """Test that negative timeouts raise InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'pricebook': '/tmp/pricebook.csv',
                    'backup_dir': '/tmp/backups',
                },
                'performance': {
                    'policy_eval_timeout_ms': -100,
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "policy_eval_timeout_ms must be positive" in str(exc_info.value)
    
    def test_load_config_handles_empty_file(self):
        """Test that empty config file returns defaults."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Create empty file
            with open(config_path, 'w') as f:
                f.write("")
            
            config = load_config(config_path)
            
            # Should return defaults
            assert isinstance(config, CaracalConfig)
            assert config.defaults.currency == "USD"
