"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for configuration management (v0.3).

Tests configuration loading, validation, and v0.3 features.
"""

import os
import tempfile
import pytest
import yaml

from caracal.config.settings import (
    CaracalConfig,
    RedisConfig,
    MerkleConfig,
    SnapshotConfig,
    AllowlistConfig,
    EventReplayConfig,
    load_config,
    get_default_config,
    _validate_config,
)
from caracal.exceptions import InvalidConfigurationError


class TestConfigurationDataclasses:
    """Test configuration dataclass structures."""
    
    
    def test_database_config_defaults(self):
        """Test DatabaseConfig has correct defaults."""
        from caracal.config.settings import DatabaseConfig
        config = DatabaseConfig()
        assert config.type == "postgres"
        assert config.host == "localhost"
        assert config.port == 5432
        assert config.database == "caracal"
        assert config.user == "caracal"
        assert config.password == ""
        assert config.file_path == ""
        assert config.pool_size == 10

    def test_redis_config_defaults(self):
        """Test RedisConfig has correct defaults."""
        config = RedisConfig()
        assert config.host == "localhost"
        assert config.port == 6379
        assert config.metrics_cache_ttl == 3600
        assert config.allowlist_cache_ttl == 60
    
    def test_merkle_config_defaults(self):
        """Test MerkleConfig has correct defaults."""
        config = MerkleConfig()
        assert config.batch_size_limit == 1000
        assert config.batch_timeout_seconds == 300
        assert config.signing_algorithm == "ES256"
        assert config.signing_backend == "software"
    
    def test_snapshot_config_defaults(self):
        """Test SnapshotConfig has correct defaults."""
        config = SnapshotConfig()
        assert config.enabled is True
        assert config.schedule_cron == "0 0 * * *"
        assert config.retention_days == 90
        assert config.compression_enabled is True
    
    def test_allowlist_config_defaults(self):
        """Test AllowlistConfig has correct defaults."""
        config = AllowlistConfig()
        assert config.enabled is True
        assert config.default_behavior == "allow"
        assert config.cache_ttl == 60
        assert config.max_patterns_per_agent == 1000
    
    def test_event_replay_config_defaults(self):
        """Test EventReplayConfig has correct defaults."""
        config = EventReplayConfig()
        assert config.batch_size == 1000
        assert config.parallelism == 4
        assert config.max_replay_duration_hours == 24
        assert config.validation_enabled is True


class TestConfigurationLoading:
    """Test configuration loading from YAML files."""
    
    def test_load_default_config(self):
        """Test loading default configuration."""
        config = get_default_config()
        assert isinstance(config, CaracalConfig)
        assert config.storage is not None
        assert config.redis is not None
        assert config.merkle is not None
        assert config.snapshot is not None
        assert config.allowlist is not None
        assert config.event_replay is not None
    
    def test_load_config_from_yaml(self):
        """Test loading configuration from YAML file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            yaml.dump({
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'backup_dir': '/tmp/backups',
                },
                'redis': {
                    'host': 'redis.example.com',
                    'port': 6380,
                },
                'merkle': {
                    'batch_size_limit': 5000,
                    'batch_timeout_seconds': 600,
                },
                'snapshot': {
                    'enabled': True,
                    'retention_days': 180,
                },
                'allowlist': {
                    'enabled': True,
                    'default_behavior': 'deny',
                },
                'event_replay': {
                    'batch_size': 2000,
                    'parallelism': 8,
                },
            }, f)
            config_path = f.name
        
        try:
            config = load_config(config_path)
            
            # Verify storage
            assert config.storage.agent_registry == '/tmp/agents.json'
            
            # Verify Redis
            assert config.redis.host == 'redis.example.com'
            assert config.redis.port == 6380
            
            # Verify Merkle
            assert config.merkle.batch_size_limit == 5000
            assert config.merkle.batch_timeout_seconds == 600
            
            # Verify Snapshot
            assert config.snapshot.enabled is True
            assert config.snapshot.retention_days == 180
            
            # Verify Allowlist
            assert config.allowlist.enabled is True
            assert config.allowlist.default_behavior == 'deny'
            
            # Verify Event Replay
            assert config.event_replay.batch_size == 2000
            assert config.event_replay.parallelism == 8
            
        finally:
            os.unlink(config_path)
    
    def test_load_config_nonexistent_file(self):
        """Test loading config from nonexistent file returns defaults."""
        config = load_config('/nonexistent/config.yaml')
        assert isinstance(config, CaracalConfig)
        # Should return defaults without error


class TestConfigurationValidation:
    """Test configuration validation."""
    
    def test_validate_valid_config(self):
        """Test that valid configuration passes validation."""
        config = get_default_config()
        # Should not raise exception
        _validate_config(config)
    
    def test_validate_redis_port_range(self):
        """Test that Redis port is validated."""
        config = get_default_config()
        config.redis.port = 99999
        
        with pytest.raises(InvalidConfigurationError, match="redis port must be between"):
            _validate_config(config)
    
    def test_validate_merkle_batch_size(self):
        """Test that Merkle batch size is validated."""
        config = get_default_config()
        config.compatibility.enable_merkle = True  # Enable merkle validation
        config.merkle.batch_size_limit = 0
        
        with pytest.raises(InvalidConfigurationError, match="merkle batch_size_limit must be at least 1"):
            _validate_config(config)
    
    def test_validate_merkle_signing_algorithm(self):
        """Test that Merkle signing algorithm is validated."""
        config = get_default_config()
        config.compatibility.enable_merkle = True  # Enable merkle validation
        config.merkle.signing_algorithm = "INVALID"
        
        with pytest.raises(InvalidConfigurationError, match="merkle signing_algorithm must be one of"):
            _validate_config(config)
    
    def test_validate_snapshot_cron_format(self):
        """Test that snapshot cron expression is validated."""
        config = get_default_config()
        config.snapshot.schedule_cron = "invalid cron"
        
        with pytest.raises(InvalidConfigurationError, match="snapshot schedule_cron must have 5 fields"):
            _validate_config(config)
    
    def test_validate_snapshot_retention_days(self):
        """Test that snapshot retention days is validated."""
        config = get_default_config()
        config.snapshot.retention_days = 0
        
        with pytest.raises(InvalidConfigurationError, match="snapshot retention_days must be at least 1"):
            _validate_config(config)
    
    def test_validate_allowlist_default_behavior(self):
        """Test that allowlist default behavior is validated."""
        config = get_default_config()
        config.allowlist.default_behavior = "invalid"
        
        with pytest.raises(InvalidConfigurationError, match="allowlist default_behavior must be one of"):
            _validate_config(config)
    
    def test_validate_allowlist_cache_ttl(self):
        """Test that allowlist cache TTL is validated."""
        config = get_default_config()
        config.allowlist.cache_ttl = 0
        
        with pytest.raises(InvalidConfigurationError, match="allowlist cache_ttl must be at least 1"):
            _validate_config(config)
    
    def test_validate_event_replay_batch_size(self):
        """Test that event replay batch size is validated."""
        config = get_default_config()
        config.event_replay.batch_size = 0
        
        with pytest.raises(InvalidConfigurationError, match="event_replay batch_size must be at least 1"):
            _validate_config(config)
    
    def test_validate_event_replay_parallelism(self):
        """Test that event replay parallelism is validated."""
        config = get_default_config()
        config.event_replay.parallelism = 0
        
        with pytest.raises(InvalidConfigurationError, match="event_replay parallelism must be at least 1"):
            _validate_config(config)


class TestEnvironmentVariableSubstitution:
    """Test environment variable substitution in configuration."""
    
    def test_env_var_substitution(self, monkeypatch):
        """Test that environment variables are substituted."""
        monkeypatch.setenv('TEST_REDIS_HOST', 'redis.example.com')
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            yaml.dump({
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'backup_dir': '/tmp/backups',
                },
                'redis': {
                    'host': '${TEST_REDIS_HOST}',
                },
            }, f)
            config_path = f.name
        
        try:
            config = load_config(config_path)
            assert config.redis.host == 'redis.example.com'
        finally:
            os.unlink(config_path)
    
    def test_env_var_with_default(self):
        """Test that environment variables with defaults work."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            yaml.dump({
                'storage': {
                    'agent_registry': '/tmp/agents.json',
                    'policy_store': '/tmp/policies.json',
                    'ledger': '/tmp/ledger.jsonl',
                    'backup_dir': '/tmp/backups',
                },
                'redis': {
                    'host': '${NONEXISTENT_VAR:default-host}',
                },
            }, f)
            config_path = f.name
        
        try:
            config = load_config(config_path)
            assert config.redis.host == 'default-host'
        finally:
            os.unlink(config_path)


class TestV03ConfigurationFeatures:
    """Test v0.3-specific configuration features."""
    
    def test_merkle_batch_thresholds(self):
        """Test Merkle batch threshold configuration."""
        config = get_default_config()
        
        # Default thresholds (compliance mode)
        assert config.merkle.batch_size_limit == 1000
        assert config.merkle.batch_timeout_seconds == 300
    
    def test_snapshot_schedule_configuration(self):
        """Test snapshot schedule configuration."""
        config = get_default_config()
        
        # Daily at midnight UTC
        assert config.snapshot.schedule_cron == "0 0 * * *"
        assert config.snapshot.retention_days == 90
        assert config.snapshot.compression_enabled is True
    
    def test_allowlist_configuration(self):
        """Test allowlist configuration."""
        config = get_default_config()
        
        assert config.allowlist.enabled is True
        assert config.allowlist.default_behavior == "allow"
        assert config.allowlist.cache_ttl == 60
        assert config.allowlist.max_patterns_per_agent == 1000
    
    def test_event_replay_configuration(self):
        """Test event replay configuration."""
        config = get_default_config()
        
        assert config.event_replay.batch_size == 1000
        assert config.event_replay.parallelism == 4
        assert config.event_replay.max_replay_duration_hours == 24
        assert config.event_replay.validation_enabled is True
