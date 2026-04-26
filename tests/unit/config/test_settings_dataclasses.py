"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for settings.py dataclasses and their pure methods.
"""
import os
import pytest

from caracal.config.settings import (
    AllowlistConfig,
    AuthorityEnforcementConfig,
    CompatibilityConfig,
    DatabaseConfig,
    DefaultsConfig,
    EventReplayConfig,
    GatewayConfig,
    LoggingConfig,
    MCPAdapterConfig,
    MerkleConfig,
    PerformanceConfig,
    PolicyCacheConfig,
    RedisConfig,
    SnapshotConfig,
    StorageConfig,
    TLSConfig,
    CaracalConfig,
)


@pytest.mark.unit
class TestDatabaseConfigConnectionUrl:
    def test_defaults_build_url(self):
        cfg = DatabaseConfig()
        url = cfg.get_connection_url()
        assert url == "postgresql://caracal:@localhost:5432/caracal"

    def test_custom_values(self):
        cfg = DatabaseConfig(
            host="dbhost", port=5433, database="mydb", user="admin", password="s3cr3t"
        )
        url = cfg.get_connection_url()
        assert "admin" in url
        assert "dbhost" in url
        assert "5433" in url
        assert "mydb" in url

    def test_password_with_special_chars_encoded(self):
        cfg = DatabaseConfig(password="p@ss/word")
        url = cfg.get_connection_url()
        assert "p%40ss%2Fword" in url

    def test_empty_password_produces_valid_url(self):
        cfg = DatabaseConfig(host="h", password="")
        url = cfg.get_connection_url()
        assert url.startswith("postgresql://")


@pytest.mark.unit
class TestStorageConfig:
    def test_required_backup_dir(self):
        cfg = StorageConfig(backup_dir="/tmp/backup")
        assert cfg.backup_dir == "/tmp/backup"

    def test_default_backup_count(self):
        cfg = StorageConfig(backup_dir="/tmp")
        assert cfg.backup_count == 3

    def test_custom_backup_count(self):
        cfg = StorageConfig(backup_dir="/tmp", backup_count=10)
        assert cfg.backup_count == 10


@pytest.mark.unit
class TestTLSConfig:
    def test_defaults(self):
        cfg = TLSConfig()
        assert cfg.enabled is True
        assert cfg.cert_file == ""
        assert cfg.key_file == ""
        assert cfg.ca_file == ""

    def test_disabled_tls(self):
        cfg = TLSConfig(enabled=False)
        assert cfg.enabled is False


@pytest.mark.unit
class TestGatewayConfig:
    def test_defaults(self):
        cfg = GatewayConfig()
        assert cfg.enabled is False
        assert cfg.auth_mode == "mtls"
        assert cfg.replay_protection_enabled is True
        assert cfg.nonce_cache_ttl == 300

    def test_custom_auth_mode(self):
        cfg = GatewayConfig(auth_mode="jwt")
        assert cfg.auth_mode == "jwt"

    def test_tls_is_default_config(self):
        cfg = GatewayConfig()
        assert isinstance(cfg.tls, TLSConfig)


@pytest.mark.unit
class TestPolicyCacheConfig:
    def test_defaults(self):
        cfg = PolicyCacheConfig()
        assert cfg.enabled is True
        assert cfg.ttl_seconds == 60
        assert cfg.max_size == 10000


@pytest.mark.unit
class TestMCPAdapterConfig:
    def test_defaults(self):
        cfg = MCPAdapterConfig()
        assert cfg.enabled is False
        assert cfg.listen_address == "0.0.0.0:8080"
        assert cfg.mcp_server_urls == []
        assert cfg.health_check_enabled is True


@pytest.mark.unit
class TestRedisConfig:
    def test_defaults(self):
        cfg = RedisConfig()
        assert cfg.host == "localhost"
        assert cfg.port == 6379
        assert cfg.db == 0
        assert cfg.ssl is False
        assert cfg.metrics_cache_ttl == 3600
        assert cfg.allowlist_cache_ttl == 60

    def test_custom_values(self):
        cfg = RedisConfig(host="redis-host", port=6380, password="secret", ssl=True)
        assert cfg.host == "redis-host"
        assert cfg.port == 6380
        assert cfg.ssl is True


@pytest.mark.unit
class TestSnapshotConfig:
    def test_defaults(self):
        cfg = SnapshotConfig()
        assert cfg.enabled is True
        assert cfg.retention_days == 90
        assert cfg.compression_enabled is True
        assert cfg.auto_cleanup_enabled is True


@pytest.mark.unit
class TestAllowlistConfig:
    def test_defaults(self):
        cfg = AllowlistConfig()
        assert cfg.enabled is True
        assert cfg.default_behavior == "allow"
        assert cfg.cache_ttl == 60
        assert cfg.max_patterns_per_principal == 1000


@pytest.mark.unit
class TestEventReplayConfig:
    def test_defaults(self):
        cfg = EventReplayConfig()
        assert cfg.batch_size == 1000
        assert cfg.parallelism == 4
        assert cfg.max_replay_duration_hours == 24
        assert cfg.validation_enabled is True


@pytest.mark.unit
class TestMerkleConfig:
    def test_defaults(self):
        cfg = MerkleConfig()
        assert cfg.batch_size_limit == 1000
        assert cfg.signing_algorithm == "ES256"
        assert cfg.signing_backend == "software"
        assert cfg.key_rotation_enabled is False
        assert cfg.hsm_config == {}

    def test_vault_backend(self):
        cfg = MerkleConfig(signing_backend="vault", vault_key_ref="kv/signing")
        assert cfg.signing_backend == "vault"
        assert cfg.vault_key_ref == "kv/signing"


@pytest.mark.unit
class TestCompatibilityConfig:
    def test_defaults(self):
        cfg = CompatibilityConfig()
        assert cfg.enable_merkle is True
        assert cfg.enable_redis is True


@pytest.mark.unit
class TestAuthorityEnforcementConfig:
    def test_defaults(self):
        cfg = AuthorityEnforcementConfig()
        assert cfg.enabled is False
        assert cfg.per_principal_rollout is False
        assert cfg.compatibility_logging_enabled is True


@pytest.mark.unit
class TestDefaultsConfig:
    def test_default_time_window(self):
        cfg = DefaultsConfig()
        assert cfg.time_window == "daily"


@pytest.mark.unit
class TestLoggingConfig:
    def test_defaults(self):
        cfg = LoggingConfig()
        assert cfg.level == "INFO"
        assert cfg.file == ""


@pytest.mark.unit
class TestPerformanceConfig:
    def test_defaults(self):
        cfg = PerformanceConfig()
        assert cfg.policy_eval_timeout_ms == 100
        assert cfg.ledger_write_timeout_ms == 10
        assert cfg.file_lock_timeout_s == 5
        assert cfg.max_retries == 3


@pytest.mark.unit
class TestCaracalConfig:
    def test_requires_storage(self):
        cfg = CaracalConfig(storage=StorageConfig(backup_dir="/tmp"))
        assert cfg.storage.backup_dir == "/tmp"

    def test_defaults_populated(self):
        cfg = CaracalConfig(storage=StorageConfig(backup_dir="/tmp"))
        assert isinstance(cfg.database, DatabaseConfig)
        assert isinstance(cfg.gateway, GatewayConfig)
        assert isinstance(cfg.redis, RedisConfig)
        assert isinstance(cfg.merkle, MerkleConfig)
        assert isinstance(cfg.logging, LoggingConfig)
        assert isinstance(cfg.performance, PerformanceConfig)

    def test_authority_enforcement_defaults_off(self):
        cfg = CaracalConfig(storage=StorageConfig(backup_dir="/tmp"))
        assert cfg.authority_enforcement.enabled is False
