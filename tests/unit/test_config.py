"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

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

        assert config.storage.backup_dir.endswith("backups")
        assert config.storage.backup_count == 3
        
        # Check defaults

        
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

                    'backup_dir': '/tmp/backups',
                    'backup_count': 5,
                },
                'defaults': {
                    'time_window': 'daily',
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

                    'backup_dir': '/tmp/backups',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            # Storage should be from file
            assert config.storage.agent_registry == '/tmp/agents.json'
            
            # Defaults should be from default config

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

                    'backup_dir': '/tmp/backups',
                },
                'defaults': {
                    'time_window': 'hourly',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "time_window must be one of" in str(exc_info.value)
    

    
    def test_validation_rejects_invalid_log_level(self):
        """Test that invalid log level raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

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




class TestAdvancedConfiguration:
    """Test database and gateway configuration features."""
    
    def test_load_config_with_database_section(self):
        """Test loading configuration with database section."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'database': {
                    'host': 'testdb.example.com',
                    'port': 5433,
                    'database': 'testdb',
                    'user': 'testuser',
                    'password': 'testpass',
                    'pool_size': 20,
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            assert config.database.host == 'testdb.example.com'
            assert config.database.port == 5433
            assert config.database.database == 'testdb'
            assert config.database.user == 'testuser'
            assert config.database.password == 'testpass'
            assert config.database.pool_size == 20
    
    def test_load_config_with_gateway_section(self):
        """Test loading configuration with gateway section."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'gateway': {
                    'enabled': True,
                    'listen_address': '0.0.0.0:9443',
                    'auth_mode': 'jwt',
                    'tls': {
                        'enabled': True,
                        'cert_file': '/etc/certs/server.crt',
                        'key_file': '/etc/certs/server.key',
                        'ca_file': '/etc/certs/ca.crt',
                    },
                    'jwt_public_key': '/etc/jwt/public.pem',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            assert config.gateway.enabled == True
            assert config.gateway.listen_address == '0.0.0.0:9443'
            assert config.gateway.auth_mode == 'jwt'
            assert config.gateway.tls.enabled == True
            assert config.gateway.tls.cert_file == '/etc/certs/server.crt'
            assert config.gateway.jwt_public_key == '/etc/jwt/public.pem'
    
    def test_load_config_with_ase_section(self):
        """Test loading configuration with ASE section."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'ase': {
                    'version': '1.0.8',
                    'delegation_token_expiration_seconds': 3600,
                    'key_algorithm': 'ES256',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            config = load_config(config_path)
            
            assert config.ase.version == '1.0.8'
            assert config.ase.delegation_token_expiration_seconds == 3600
            assert config.ase.key_algorithm == 'ES256'
    
    def test_environment_variable_expansion(self):
        """Test environment variable expansion in configuration."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            # Set test environment variables
            os.environ['TEST_DB_HOST'] = 'envhost.example.com'
            os.environ['TEST_DB_PORT'] = '5433'
            os.environ['TEST_DB_PASSWORD'] = 'envpass'
            
            try:
                config_data = {
                    'storage': {
                        'agent_registry': '/tmp/agents.json',
                        'policy_store': '/tmp/policies.json',
                        'ledger': '/tmp/ledger.jsonl',

                        'backup_dir': '/tmp/backups',
                    },
                    'database': {
                        'host': '${TEST_DB_HOST}',
                        'port': '${TEST_DB_PORT}',
                        'database': '${TEST_DB_NAME:defaultdb}',  # With default
                        'password': '${TEST_DB_PASSWORD}',
                    },
                }
                
                with open(config_path, 'w') as f:
                    yaml.dump(config_data, f)
                
                config = load_config(config_path)
                
                assert config.database.host == 'envhost.example.com'
                assert config.database.port == 5433
                assert config.database.password == 'envpass'
                assert config.database.database == 'defaultdb'  # Default value used
            finally:
                # Clean up environment variables
                del os.environ['TEST_DB_HOST']
                del os.environ['TEST_DB_PORT']
                del os.environ['TEST_DB_PASSWORD']
    
    def test_validation_rejects_invalid_database_port(self):
        """Test that invalid database port raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'database': {
                    'port': 99999,  # Invalid port
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "port must be between 1 and 65535" in str(exc_info.value)
    
    def test_validation_rejects_invalid_gateway_auth_mode(self):
        """Test that invalid gateway auth mode raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'gateway': {
                    'enabled': True,
                    'listen_address': '0.0.0.0:8443',
                    'auth_mode': 'invalid_mode',
                    'tls': {
                        'enabled': True,
                        'cert_file': '/etc/certs/server.crt',
                        'key_file': '/etc/certs/server.key',
                    },
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "auth_mode must be one of" in str(exc_info.value)
    
    def test_validation_requires_tls_cert_when_enabled(self):
        """Test that TLS cert is required when TLS is enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'gateway': {
                    'enabled': True,
                    'listen_address': '0.0.0.0:8443',
                    'auth_mode': 'mtls',
                    'tls': {
                        'enabled': True,
                        'cert_file': '',  # Empty cert file
                        'key_file': '/etc/certs/server.key',
                    },
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "cert_file cannot be empty" in str(exc_info.value)
    
    def test_validation_rejects_invalid_ase_key_algorithm(self):
        """Test that invalid ASE key algorithm raises InvalidConfigurationError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config.yaml")
            
            config_data = {
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',

                    'backup_dir': '/tmp/backups',
                },
                'ase': {
                    'key_algorithm': 'INVALID_ALG',
                },
            }
            
            with open(config_path, 'w') as f:
                yaml.dump(config_data, f)
            
            with pytest.raises(InvalidConfigurationError) as exc_info:
                load_config(config_path)
            
            assert "key_algorithm must be one of" in str(exc_info.value)
