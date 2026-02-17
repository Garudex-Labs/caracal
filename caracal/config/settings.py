"""
Configuration management for Caracal Core.

Loads YAML configuration from file with sensible defaults and validation.
Supports environment variable substitution using ${ENV_VAR} syntax.
Supports encrypted configuration values using ENC[...] syntax.
"""
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from caracal.exceptions import ConfigurationError, InvalidConfigurationError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def _expand_env_vars(value: Any) -> Any:
    """
    Recursively expand environment variables in configuration values.
    
    Supports ${ENV_VAR} syntax with optional default values: ${ENV_VAR:default}
    
    Args:
        value: Configuration value (string, dict, list, or other)
    
    Returns:
        Value with environment variables expanded
    
    Examples:
        "${DATABASE_HOST}" -> value of DATABASE_HOST env var
        "${DATABASE_HOST:localhost}" -> value of DATABASE_HOST or "localhost" if not set
        "host: ${DATABASE_HOST}, port: ${DATABASE_PORT:5432}" -> expanded string
    """
    if isinstance(value, str):
        # Pattern matches ${VAR} or ${VAR:default}
        pattern = r'\$\{([^}:]+)(?::([^}]*))?\}'
        
        def replace_env_var(match):
            var_name = match.group(1)
            default_value = match.group(2) if match.group(2) is not None else ""
            return os.environ.get(var_name, default_value)
        
        return re.sub(pattern, replace_env_var, value)
    elif isinstance(value, dict):
        return {k: _expand_env_vars(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_expand_env_vars(item) for item in value]
    else:
        return value


def _decrypt_config_values(config_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recursively decrypt encrypted configuration values.
    
    Encrypted values use the format: ENC[base64_encoded_ciphertext]
    Requires CARACAL_MASTER_PASSWORD environment variable to be set.
    
    Args:
        config_data: Configuration dictionary
    
    Returns:
        Configuration dictionary with decrypted values
    """
    # Check if any values are encrypted
    has_encrypted = _has_encrypted_values(config_data)
    
    if not has_encrypted:
        return config_data
    
    # Import encryption module (lazy import to avoid circular dependency)
    try:
        from caracal.config.encryption import ConfigEncryption
        
        # Initialize encryptor (will use CARACAL_MASTER_PASSWORD env var)
        encryptor = ConfigEncryption()
        
        # Decrypt all encrypted values
        decrypted_config = encryptor.decrypt_config(config_data)
        
        logger.debug("Decrypted configuration values")
        
        return decrypted_config
        
    except ImportError:
        logger.error("Encryption module not available, cannot decrypt configuration")
        raise InvalidConfigurationError(
            "Configuration contains encrypted values but encryption module is not available"
        )
    except ValueError as e:
        logger.error(f"Failed to decrypt configuration: {e}")
        raise InvalidConfigurationError(
            f"Failed to decrypt configuration: {e}. "
            "Ensure CARACAL_MASTER_PASSWORD environment variable is set correctly."
        )


def _has_encrypted_values(value: Any) -> bool:
    """
    Check if configuration contains any encrypted values.
    
    Args:
        value: Configuration value (string, dict, list, or other)
    
    Returns:
        True if any encrypted values found, False otherwise
    """
    if isinstance(value, str):
        return value.startswith("ENC[") and value.endswith("]")
    elif isinstance(value, dict):
        return any(_has_encrypted_values(v) for v in value.values())
    elif isinstance(value, list):
        return any(_has_encrypted_values(item) for item in value)
    else:
        return False


@dataclass
class StorageConfig:
    """Storage configuration for file paths."""
    
    agent_registry: str
    policy_store: str
    ledger: str
    backup_dir: str
    backup_count: int = 3


@dataclass
class DatabaseConfig:
    """Database configuration."""
    
    type: str = "postgres"  # "postgres" or "sqlite"
    host: str = "localhost"
    port: int = 5432
    database: str = "caracal"
    user: str = "caracal"
    password: str = ""
    file_path: str = ""  # For SQLite
    pool_size: int = 10
    max_overflow: int = 5
    pool_timeout: int = 30

    def get_connection_url(self) -> str:
        """Get database connection URL."""
        if self.type == "sqlite":
            return f"sqlite:///{self.file_path}"
        
        # Postgres default
        return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"


@dataclass
class TLSConfig:
    """TLS configuration for gateway proxy."""
    
    enabled: bool = True
    cert_file: str = ""
    key_file: str = ""
    ca_file: str = ""


@dataclass
class GatewayConfig:
    """Gateway proxy configuration."""
    
    enabled: bool = False
    listen_address: str = "0.0.0.0:8443"
    tls: TLSConfig = field(default_factory=TLSConfig)
    auth_mode: str = "mtls"  # "mtls", "jwt", or "api_key"
    jwt_public_key: str = ""
    replay_protection_enabled: bool = True
    nonce_cache_ttl: int = 300  # 5 minutes


@dataclass
class PolicyCacheConfig:
    """Policy cache configuration for degraded mode."""
    
    enabled: bool = True
    ttl_seconds: int = 60
    max_size: int = 10000





@dataclass
class MCPAdapterConfig:
    """MCP adapter configuration."""
    
    enabled: bool = False
    listen_address: str = "0.0.0.0:8080"
    mcp_server_urls: list = field(default_factory=list)

    health_check_enabled: bool = True


@dataclass
class ASEConfig:
    """ASE protocol configuration."""
    
    version: str = "1.0.8"
    delegation_token_expiration_seconds: int = 86400  # 24 hours
    key_algorithm: str = "RS256"  # RS256 or ES256


@dataclass
class RedisConfig:
    """Redis configuration."""
    
    host: str = "localhost"
    port: int = 6379
    password: str = ""
    db: int = 0
    ssl: bool = False
    ssl_ca_certs: str = ""  # Path to CA certificate for TLS
    ssl_certfile: str = ""  # Path to client certificate for TLS
    ssl_keyfile: str = ""  # Path to client private key for TLS
    metrics_cache_ttl: int = 3600  # 1 hour
    allowlist_cache_ttl: int = 60  # 1 minute


@dataclass
class SnapshotConfig:
    """Ledger snapshot configuration for v0.3."""
    
    enabled: bool = True
    schedule_cron: str = "0 0 * * *"  # Daily at midnight UTC
    retention_days: int = 90  # Retain snapshots for 90 days
    storage_path: str = ""  # Path to snapshot storage directory
    compression_enabled: bool = True  # Compress snapshots with gzip
    auto_cleanup_enabled: bool = True  # Automatically delete old snapshots


@dataclass
class AllowlistConfig:
    """Resource allowlist configuration for v0.3."""
    
    enabled: bool = True
    default_behavior: str = "allow"  # "allow" or "deny" when no allowlist defined
    cache_ttl: int = 60  # Cache compiled patterns for 60 seconds
    max_patterns_per_agent: int = 1000  # Maximum patterns per agent


@dataclass
class EventReplayConfig:
    """Event replay configuration for v0.3."""
    
    batch_size: int = 1000  # Number of events to process per batch
    parallelism: int = 4  # Number of parallel replay workers
    max_replay_duration_hours: int = 24  # Maximum replay duration
    validation_enabled: bool = True  # Validate event ordering during replay


@dataclass
class MerkleConfig:
    """Merkle tree configuration for v0.3."""
    
    batch_size_limit: int = 1000  # Max events per batch
    batch_timeout_seconds: int = 300  # Max time before batch closes (5 minutes)
    signing_algorithm: str = "ES256"  # ECDSA P-256
    signing_backend: str = "software"  # "software" (default) or "hsm" (Enterprise only)
    private_key_path: str = ""  # Path to private key for software signing
    key_encryption_passphrase: str = ""  # Passphrase for encrypted key (from env var)
    key_rotation_enabled: bool = False  # Enable automatic key rotation
    key_rotation_days: int = 90  # Rotate keys every 90 days
    # HSM configuration (Enterprise only, ignored if signing_backend=software)
    hsm_config: dict = field(default_factory=dict)


@dataclass
class CompatibilityConfig:
    """Feature flags for optional infrastructure components."""
    
    enable_merkle: bool = False  # If False, skip Merkle tree computation (simpler deployment)
    enable_redis: bool = True  # If False, skip Redis caching (PostgreSQL-only mode)


@dataclass
class AuthorityEnforcementConfig:
    """Authority enforcement feature flags for gradual rollout."""
    
    enabled: bool = False  # Global authority enforcement flag
    per_principal_rollout: bool = False  # Enable per-principal authority enforcement

    compatibility_logging_enabled: bool = True  # Log compatibility mode usage
    compatibility_logging_enabled: bool = True  # Log compatibility mode usage


@dataclass
class DefaultsConfig:
    """Default values configuration."""
    
    time_window: str = "daily"


@dataclass
class LoggingConfig:
    """Logging configuration."""
    
    level: str = "INFO"
    file: str = ""
    format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"


@dataclass
class PerformanceConfig:
    """Performance tuning configuration."""
    
    policy_eval_timeout_ms: int = 100
    ledger_write_timeout_ms: int = 10
    file_lock_timeout_s: int = 5
    max_retries: int = 3


@dataclass
class CaracalConfig:
    """Main Caracal Core configuration."""
    
    storage: StorageConfig
    defaults: DefaultsConfig = field(default_factory=DefaultsConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    performance: PerformanceConfig = field(default_factory=PerformanceConfig)
    database: DatabaseConfig = field(default_factory=DatabaseConfig)
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    policy_cache: PolicyCacheConfig = field(default_factory=PolicyCacheConfig)
    mcp_adapter: MCPAdapterConfig = field(default_factory=MCPAdapterConfig)
    ase: ASEConfig = field(default_factory=ASEConfig)
    redis: RedisConfig = field(default_factory=RedisConfig)
    merkle: MerkleConfig = field(default_factory=MerkleConfig)
    snapshot: SnapshotConfig = field(default_factory=SnapshotConfig)
    allowlist: AllowlistConfig = field(default_factory=AllowlistConfig)
    event_replay: EventReplayConfig = field(default_factory=EventReplayConfig)
    compatibility: CompatibilityConfig = field(default_factory=CompatibilityConfig)
    authority_enforcement: AuthorityEnforcementConfig = field(default_factory=AuthorityEnforcementConfig)


def get_default_config_path() -> str:
    """Get the default configuration file path."""
    from caracal.flow.workspace import get_workspace
    return str(get_workspace().config_path)


def get_default_config() -> CaracalConfig:
    """
    Get default configuration with sensible defaults.
    
    Returns:
        CaracalConfig: Default configuration object
    """
    from caracal.flow.workspace import get_workspace
    ws = get_workspace()
    home_dir = str(ws.root)
    
    storage = StorageConfig(
        agent_registry=str(ws.agents_path),
        policy_store=str(ws.policies_path),
        ledger=str(ws.ledger_path),
        backup_dir=str(ws.backups_dir),
        backup_count=3,
    )
    
    defaults = DefaultsConfig(
        time_window="daily",
    )
    
    logging = LoggingConfig(
        level="INFO",
        file=str(ws.log_path),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    
    performance = PerformanceConfig(
        policy_eval_timeout_ms=100,
        ledger_write_timeout_ms=10,
        file_lock_timeout_s=5,
        max_retries=3,
    )
    
    return CaracalConfig(
        storage=storage,
        defaults=defaults,
        logging=logging,
        performance=performance,
    )


def load_config(config_path: Optional[str] = None) -> CaracalConfig:
    """
    Load configuration from YAML file with validation.
    
    If config file is not found, returns default configuration.
    If config file is malformed or invalid, raises ConfigurationError.
    
    Args:
        config_path: Path to configuration file. If None, uses default path.
    
    Returns:
        CaracalConfig: Loaded and validated configuration
    
    Raises:
        InvalidConfigurationError: If configuration is invalid or malformed
    """
    if config_path is None:
        config_path = get_default_config_path()
    
    # Expand user home directory
    config_path = os.path.expanduser(config_path)
    
    # If config file doesn't exist, return defaults
    if not os.path.exists(config_path):
        logger.info(f"Configuration file not found at {config_path}, using defaults")
        return get_default_config()
    
    # Load YAML file
    try:
        with open(config_path, 'r') as f:
            config_data = yaml.safe_load(f)
        logger.debug(f"Loaded configuration from {config_path}")
    except yaml.YAMLError as e:
        logger.error(f"Failed to parse YAML configuration file '{config_path}': {e}", exc_info=True)
        raise InvalidConfigurationError(
            f"Failed to parse YAML configuration file '{config_path}': {e}"
        )
    except Exception as e:
        logger.error(f"Failed to read configuration file '{config_path}': {e}", exc_info=True)
        raise InvalidConfigurationError(
            f"Failed to read configuration file '{config_path}': {e}"
        )
    
    # If file is empty, return defaults
    if config_data is None:
        logger.info(f"Configuration file {config_path} is empty, using defaults")
        return get_default_config()
    
    # Expand environment variables in configuration
    config_data = _expand_env_vars(config_data)
    logger.debug("Expanded environment variables in configuration")
    
    # Decrypt encrypted configuration values
    config_data = _decrypt_config_values(config_data)
    logger.debug("Decrypted encrypted configuration values")
    
    # Validate and build configuration
    try:
        config = _build_config_from_dict(config_data)
        _validate_config(config)
        logger.info(f"Successfully loaded and validated configuration from {config_path}")
        return config
    except Exception as e:
        logger.error(f"Invalid configuration in '{config_path}': {e}", exc_info=True)
        raise InvalidConfigurationError(
            f"Invalid configuration in '{config_path}': {e}"
        )


def _build_config_from_dict(config_data: Dict[str, Any]) -> CaracalConfig:
    """
    Build CaracalConfig from dictionary loaded from YAML.
    
    Merges user configuration with defaults.
    
    Args:
        config_data: Dictionary loaded from YAML file
    
    Returns:
        CaracalConfig: Configuration object
    
    Raises:
        InvalidConfigurationError: If required fields are missing
    """
    # Start with defaults
    default_config = get_default_config()
    
    # Parse storage configuration (required)
    if 'storage' not in config_data:
        logger.error("Missing required 'storage' section in configuration")
        raise InvalidConfigurationError("Missing required 'storage' section in configuration")
    
    storage_data = config_data['storage']
    
    # Expand paths with user home directory
    storage = StorageConfig(
        agent_registry=os.path.expanduser(
            storage_data.get('agent_registry', default_config.storage.agent_registry)
        ),
        policy_store=os.path.expanduser(
            storage_data.get('policy_store', default_config.storage.policy_store)
        ),
        ledger=os.path.expanduser(
            storage_data.get('ledger', default_config.storage.ledger)
        ),
        backup_dir=os.path.expanduser(
            storage_data.get('backup_dir', default_config.storage.backup_dir)
        ),
        backup_count=storage_data.get('backup_count', default_config.storage.backup_count),
    )
    
    # Parse defaults configuration (optional)
    defaults_data = config_data.get('defaults', {})
    defaults = DefaultsConfig(
        time_window=defaults_data.get('time_window', default_config.defaults.time_window),
    )
    
    # Parse logging configuration (optional)
    logging_data = config_data.get('logging', {})
    logging = LoggingConfig(
        level=logging_data.get('level', default_config.logging.level),
        file=os.path.expanduser(
            logging_data.get('file', default_config.logging.file)
        ),
        format=logging_data.get('format', default_config.logging.format),
    )
    
    # Parse performance configuration (optional)
    performance_data = config_data.get('performance', {})
    performance = PerformanceConfig(
        policy_eval_timeout_ms=performance_data.get(
            'policy_eval_timeout_ms', default_config.performance.policy_eval_timeout_ms
        ),
        ledger_write_timeout_ms=performance_data.get(
            'ledger_write_timeout_ms', default_config.performance.ledger_write_timeout_ms
        ),
        file_lock_timeout_s=performance_data.get(
            'file_lock_timeout_s', default_config.performance.file_lock_timeout_s
        ),
        max_retries=performance_data.get(
            'max_retries', default_config.performance.max_retries
        ),
    )
    
    # Parse database configuration (optional, for v0.2)
    database_data = config_data.get('database', {})
    database = DatabaseConfig(
        type=database_data.get('type', default_config.database.type),
        host=database_data.get('host', default_config.database.host),
        port=database_data.get('port', default_config.database.port),
        database=database_data.get('database', default_config.database.database),
        user=database_data.get('user', default_config.database.user),
        password=database_data.get('password', default_config.database.password),
        file_path=os.path.expanduser(database_data.get('file_path', default_config.database.file_path)),
        pool_size=database_data.get('pool_size', default_config.database.pool_size),
        max_overflow=database_data.get('max_overflow', default_config.database.max_overflow),
        pool_timeout=database_data.get('pool_timeout', default_config.database.pool_timeout),
    )
    
    # Parse gateway configuration (optional, for v0.2)
    gateway_data = config_data.get('gateway', {})
    tls_data = gateway_data.get('tls', {})
    tls = TLSConfig(
        enabled=tls_data.get('enabled', default_config.gateway.tls.enabled),
        cert_file=os.path.expanduser(tls_data.get('cert_file', default_config.gateway.tls.cert_file)),
        key_file=os.path.expanduser(tls_data.get('key_file', default_config.gateway.tls.key_file)),
        ca_file=os.path.expanduser(tls_data.get('ca_file', default_config.gateway.tls.ca_file)),
    )
    gateway = GatewayConfig(
        enabled=gateway_data.get('enabled', default_config.gateway.enabled),
        listen_address=gateway_data.get('listen_address', default_config.gateway.listen_address),
        tls=tls,
        auth_mode=gateway_data.get('auth_mode', default_config.gateway.auth_mode),
        jwt_public_key=os.path.expanduser(gateway_data.get('jwt_public_key', default_config.gateway.jwt_public_key)),
        replay_protection_enabled=gateway_data.get('replay_protection_enabled', default_config.gateway.replay_protection_enabled),
        nonce_cache_ttl=gateway_data.get('nonce_cache_ttl', default_config.gateway.nonce_cache_ttl),
    )
    
    # Parse policy cache configuration (optional, for v0.2)
    policy_cache_data = config_data.get('policy_cache', {})
    policy_cache = PolicyCacheConfig(
        enabled=policy_cache_data.get('enabled', default_config.policy_cache.enabled),
        ttl_seconds=policy_cache_data.get('ttl_seconds', default_config.policy_cache.ttl_seconds),
        max_size=policy_cache_data.get('max_size', default_config.policy_cache.max_size),
    )
    
    # Parse MCP adapter configuration (optional, for v0.2)
    mcp_adapter_data = config_data.get('mcp_adapter', {})
    mcp_adapter = MCPAdapterConfig(
        enabled=mcp_adapter_data.get('enabled', default_config.mcp_adapter.enabled),
        listen_address=mcp_adapter_data.get('listen_address', default_config.mcp_adapter.listen_address),
        mcp_server_urls=mcp_adapter_data.get('mcp_server_urls', default_config.mcp_adapter.mcp_server_urls),
        health_check_enabled=mcp_adapter_data.get('health_check_enabled', default_config.mcp_adapter.health_check_enabled),
    )
    
    # Parse ASE configuration (optional, for v0.2)
    ase_data = config_data.get('ase', {})
    ase = ASEConfig(
        version=ase_data.get('version', default_config.ase.version),
        delegation_token_expiration_seconds=ase_data.get('delegation_token_expiration_seconds', default_config.ase.delegation_token_expiration_seconds),
        key_algorithm=ase_data.get('key_algorithm', default_config.ase.key_algorithm),
    )
    
    # Parse Merkle configuration (optional, for v0.3)
    merkle_data = config_data.get('merkle', {})
    merkle = MerkleConfig(
        batch_size_limit=merkle_data.get('batch_size_limit', default_config.merkle.batch_size_limit),
        batch_timeout_seconds=merkle_data.get('batch_timeout_seconds', default_config.merkle.batch_timeout_seconds),
        signing_algorithm=merkle_data.get('signing_algorithm', default_config.merkle.signing_algorithm),
        signing_backend=merkle_data.get('signing_backend', default_config.merkle.signing_backend),
        private_key_path=os.path.expanduser(merkle_data.get('private_key_path', default_config.merkle.private_key_path)),
        key_encryption_passphrase=merkle_data.get('key_encryption_passphrase', default_config.merkle.key_encryption_passphrase),
        key_rotation_enabled=merkle_data.get('key_rotation_enabled', default_config.merkle.key_rotation_enabled),
        key_rotation_days=merkle_data.get('key_rotation_days', default_config.merkle.key_rotation_days),
        hsm_config=merkle_data.get('hsm_config', default_config.merkle.hsm_config),
    )
    
    # Parse Redis configuration (optional)
    redis_data = config_data.get('redis', {})
    redis = RedisConfig(
        host=redis_data.get('host', default_config.redis.host),
        port=redis_data.get('port', default_config.redis.port),
        password=redis_data.get('password', default_config.redis.password),
        db=redis_data.get('db', default_config.redis.db),
        ssl=redis_data.get('ssl', default_config.redis.ssl),
        ssl_ca_certs=os.path.expanduser(redis_data.get('ssl_ca_certs', default_config.redis.ssl_ca_certs)),
        ssl_certfile=os.path.expanduser(redis_data.get('ssl_certfile', default_config.redis.ssl_certfile)),
        ssl_keyfile=os.path.expanduser(redis_data.get('ssl_keyfile', default_config.redis.ssl_keyfile)),
        metrics_cache_ttl=redis_data.get('metrics_cache_ttl', default_config.redis.metrics_cache_ttl),
        allowlist_cache_ttl=redis_data.get('allowlist_cache_ttl', default_config.redis.allowlist_cache_ttl),
    )
    
    # Parse snapshot configuration (optional, for v0.3)
    snapshot_data = config_data.get('snapshot', {})
    snapshot = SnapshotConfig(
        enabled=snapshot_data.get('enabled', default_config.snapshot.enabled),
        schedule_cron=snapshot_data.get('schedule_cron', default_config.snapshot.schedule_cron),
        retention_days=snapshot_data.get('retention_days', default_config.snapshot.retention_days),
        storage_path=os.path.expanduser(snapshot_data.get('storage_path', default_config.snapshot.storage_path)),
        compression_enabled=snapshot_data.get('compression_enabled', default_config.snapshot.compression_enabled),
        auto_cleanup_enabled=snapshot_data.get('auto_cleanup_enabled', default_config.snapshot.auto_cleanup_enabled),
    )
    
    # Parse allowlist configuration (optional, for v0.3)
    allowlist_data = config_data.get('allowlist', {})
    allowlist = AllowlistConfig(
        enabled=allowlist_data.get('enabled', default_config.allowlist.enabled),
        default_behavior=allowlist_data.get('default_behavior', default_config.allowlist.default_behavior),
        cache_ttl=allowlist_data.get('cache_ttl', default_config.allowlist.cache_ttl),
        max_patterns_per_agent=allowlist_data.get('max_patterns_per_agent', default_config.allowlist.max_patterns_per_agent),
    )
    
    # Parse event replay configuration (optional, for v0.3)
    event_replay_data = config_data.get('event_replay', {})
    event_replay = EventReplayConfig(
        batch_size=event_replay_data.get('batch_size', default_config.event_replay.batch_size),
        parallelism=event_replay_data.get('parallelism', default_config.event_replay.parallelism),
        max_replay_duration_hours=event_replay_data.get('max_replay_duration_hours', default_config.event_replay.max_replay_duration_hours),
        validation_enabled=event_replay_data.get('validation_enabled', default_config.event_replay.validation_enabled),
    )
    
    # Parse compatibility configuration (optional feature flags)
    compatibility_data = config_data.get('compatibility', {})
    compatibility = CompatibilityConfig(
        enable_merkle=compatibility_data.get('enable_merkle', default_config.compatibility.enable_merkle),
        enable_redis=compatibility_data.get('enable_redis', default_config.compatibility.enable_redis),
    )
    
    # Parse authority enforcement configuration (optional, for v0.5 authority enforcement)
    authority_enforcement_data = config_data.get('authority_enforcement', {})
    authority_enforcement = AuthorityEnforcementConfig(
        enabled=authority_enforcement_data.get('enabled', default_config.authority_enforcement.enabled),
        per_principal_rollout=authority_enforcement_data.get('per_principal_rollout', default_config.authority_enforcement.per_principal_rollout),
        compatibility_logging_enabled=authority_enforcement_data.get('compatibility_logging_enabled', default_config.authority_enforcement.compatibility_logging_enabled),
    )
    
    # Log info about optional features
    if not compatibility.enable_merkle:
        logger.info("Merkle tree ledger is disabled - no cryptographic tamper-evidence")
    if not compatibility.enable_redis:
        logger.info("Redis caching is disabled - using PostgreSQL for all queries")
    
    # Log warnings for authority enforcement configuration
    # Log warnings for authority enforcement configuration
    if authority_enforcement.enabled:
        logger.info("Authority enforcement enabled")
        if authority_enforcement.per_principal_rollout:
            logger.info("Per-principal authority enforcement rollout enabled")
        if authority_enforcement.compatibility_mode_enabled:
            logger.info("Legacy compatibility mode enabled")
    
    return CaracalConfig(
        storage=storage,
        defaults=defaults,
        logging=logging,
        performance=performance,
        database=database,
        gateway=gateway,
        policy_cache=policy_cache,
        mcp_adapter=mcp_adapter,
        ase=ase,
        redis=redis,
        merkle=merkle,
        snapshot=snapshot,
        allowlist=allowlist,
        event_replay=event_replay,
        compatibility=compatibility,
        authority_enforcement=authority_enforcement,
    )


def _validate_config(config: CaracalConfig) -> None:
    """
    Validate configuration values.
    
    Args:
        config: Configuration to validate
    
    Raises:
        InvalidConfigurationError: If configuration is invalid
    """
    # Validate storage paths are not empty
    if not config.storage.agent_registry:
        logger.error("Configuration validation failed: agent_registry path cannot be empty")
        raise InvalidConfigurationError("agent_registry path cannot be empty")
    if not config.storage.policy_store:
        logger.error("Configuration validation failed: policy_store path cannot be empty")
        raise InvalidConfigurationError("policy_store path cannot be empty")
    if not config.storage.ledger:
        logger.error("Configuration validation failed: ledger path cannot be empty")
        raise InvalidConfigurationError("ledger path cannot be empty")
    # Validate agent registry path is not empty
    if not config.storage.agent_registry:
        logger.error("Configuration validation failed: agent_registry path cannot be empty")
        raise InvalidConfigurationError("agent_registry path cannot be empty")
    
    # Validate backup count is positive
    if config.storage.backup_count < 1:
        raise InvalidConfigurationError(
            f"backup_count must be at least 1, got {config.storage.backup_count}"
        )
    

    
    # Validate time window
    valid_time_windows = ["daily"]  # v0.1 only supports daily
    if config.defaults.time_window not in valid_time_windows:
        raise InvalidConfigurationError(
            f"time_window must be one of {valid_time_windows}, "
            f"got '{config.defaults.time_window}'"
        )
    

    
    # Validate logging level
    valid_log_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    if config.logging.level.upper() not in valid_log_levels:
        raise InvalidConfigurationError(
            f"logging level must be one of {valid_log_levels}, "
            f"got '{config.logging.level}'"
        )
    
    # Validate performance timeouts are positive
    if config.performance.policy_eval_timeout_ms <= 0:
        raise InvalidConfigurationError(
            f"policy_eval_timeout_ms must be positive, "
            f"got {config.performance.policy_eval_timeout_ms}"
        )
    if config.performance.ledger_write_timeout_ms <= 0:
        raise InvalidConfigurationError(
            f"ledger_write_timeout_ms must be positive, "
            f"got {config.performance.ledger_write_timeout_ms}"
        )
    if config.performance.file_lock_timeout_s <= 0:
        raise InvalidConfigurationError(
            f"file_lock_timeout_s must be positive, "
            f"got {config.performance.file_lock_timeout_s}"
        )
    if config.performance.max_retries < 1:
        raise InvalidConfigurationError(
            f"max_retries must be at least 1, got {config.performance.max_retries}"
        )
    
    # Validate database configuration (v0.2)
    try:
        config.database.port = int(config.database.port)
        config.database.pool_size = int(config.database.pool_size)
        config.database.max_overflow = int(config.database.max_overflow)
        config.database.pool_timeout = int(config.database.pool_timeout)
    except (ValueError, TypeError):
        raise InvalidConfigurationError("Database numeric configuration values must be integers")

    if config.database.port < 1 or config.database.port > 65535:
        raise InvalidConfigurationError(
            f"database port must be between 1 and 65535, got {config.database.port}"
        )
    if not config.database.host:
        raise InvalidConfigurationError("database host cannot be empty")
    if not config.database.database:
        raise InvalidConfigurationError("database name cannot be empty")
    if not config.database.user:
        raise InvalidConfigurationError("database user cannot be empty")
    if config.database.pool_size < 1:
        raise InvalidConfigurationError(
            f"database pool_size must be at least 1, got {config.database.pool_size}"
        )
    if config.database.max_overflow < 0:
        raise InvalidConfigurationError(
            f"database max_overflow must be non-negative, got {config.database.max_overflow}"
        )
    if config.database.pool_timeout <= 0:
        raise InvalidConfigurationError(
            f"database pool_timeout must be positive, got {config.database.pool_timeout}"
        )
    
    # Validate gateway configuration (v0.2)
    if config.gateway.enabled:
        if not config.gateway.listen_address:
            raise InvalidConfigurationError("gateway listen_address cannot be empty when gateway is enabled")
        
        # Validate auth mode
        valid_auth_modes = ["mtls", "jwt", "api_key"]
        if config.gateway.auth_mode not in valid_auth_modes:
            raise InvalidConfigurationError(
                f"gateway auth_mode must be one of {valid_auth_modes}, "
                f"got '{config.gateway.auth_mode}'"
            )
        
        # Validate TLS configuration
        if config.gateway.tls.enabled:
            if not config.gateway.tls.cert_file:
                raise InvalidConfigurationError("gateway TLS cert_file cannot be empty when TLS is enabled")
            if not config.gateway.tls.key_file:
                raise InvalidConfigurationError("gateway TLS key_file cannot be empty when TLS is enabled")
            if config.gateway.auth_mode == "mtls" and not config.gateway.tls.ca_file:
                raise InvalidConfigurationError("gateway TLS ca_file cannot be empty when mTLS authentication is enabled")
        
        # Validate JWT configuration
        if config.gateway.auth_mode == "jwt" and not config.gateway.jwt_public_key:
            raise InvalidConfigurationError("gateway jwt_public_key cannot be empty when JWT authentication is enabled")
        
        # Validate nonce cache TTL
        if config.gateway.replay_protection_enabled and config.gateway.nonce_cache_ttl <= 0:
            raise InvalidConfigurationError(
                f"gateway nonce_cache_ttl must be positive, got {config.gateway.nonce_cache_ttl}"
            )
    
    # Validate policy cache configuration (v0.2)
    if config.policy_cache.enabled:
        if config.policy_cache.ttl_seconds <= 0:
            raise InvalidConfigurationError(
                f"policy_cache ttl_seconds must be positive, got {config.policy_cache.ttl_seconds}"
            )
        if config.policy_cache.max_size < 1:
            raise InvalidConfigurationError(
                f"policy_cache max_size must be at least 1, got {config.policy_cache.max_size}"
            )
    
    # Validate MCP adapter configuration (v0.2)
    if config.mcp_adapter.enabled:
        if not config.mcp_adapter.listen_address:
            raise InvalidConfigurationError("mcp_adapter listen_address cannot be empty when MCP adapter is enabled")
    
    # Validate ASE configuration (v0.2)
    if config.ase.delegation_token_expiration_seconds <= 0:
        raise InvalidConfigurationError(
            f"ase delegation_token_expiration_seconds must be positive, "
            f"got {config.ase.delegation_token_expiration_seconds}"
        )
    
    valid_key_algorithms = ["RS256", "ES256"]
    if config.ase.key_algorithm not in valid_key_algorithms:
        raise InvalidConfigurationError(
            f"ase key_algorithm must be one of {valid_key_algorithms}, "
            f"got '{config.ase.key_algorithm}'"
        )
    

    
    # Validate Merkle configuration (v0.3)
    if config.compatibility.enable_merkle:
        # Cast to int to handle env var string values
        try:
            config.merkle.batch_size_limit = int(config.merkle.batch_size_limit)
            config.merkle.batch_timeout_seconds = int(config.merkle.batch_timeout_seconds)
            if config.merkle.key_rotation_enabled:
                 config.merkle.key_rotation_days = int(config.merkle.key_rotation_days)
        except (ValueError, TypeError):
            raise InvalidConfigurationError("Merkle numeric configuration values must be integers")
        if config.merkle.batch_size_limit < 1:
            raise InvalidConfigurationError(
                f"merkle batch_size_limit must be at least 1, got {config.merkle.batch_size_limit}"
            )
        if config.merkle.batch_timeout_seconds < 1:
            raise InvalidConfigurationError(
                f"merkle batch_timeout_seconds must be at least 1, got {config.merkle.batch_timeout_seconds}"
            )
        
        valid_signing_algorithms = ["ES256"]
        if config.merkle.signing_algorithm not in valid_signing_algorithms:
            raise InvalidConfigurationError(
                f"merkle signing_algorithm must be one of {valid_signing_algorithms}, "
                f"got '{config.merkle.signing_algorithm}'"
            )
        
        valid_signing_backends = ["software", "hsm"]
        if config.merkle.signing_backend not in valid_signing_backends:
            raise InvalidConfigurationError(
                f"merkle signing_backend must be one of {valid_signing_backends}, "
                f"got '{config.merkle.signing_backend}'"
            )
        
        # Validate software signing configuration
        if config.merkle.signing_backend == "software":
            if not config.merkle.private_key_path:
                raise InvalidConfigurationError(
                    "merkle private_key_path is required when signing_backend is 'software'"
                )
        
        # Validate key rotation configuration
        if config.merkle.key_rotation_enabled:
            if config.merkle.key_rotation_days < 1:
                raise InvalidConfigurationError(
                    f"merkle key_rotation_days must be at least 1, got {config.merkle.key_rotation_days}"
                )
    
    # Validate Redis configuration
    if config.compatibility.enable_redis:
        if not config.redis.host:
            raise InvalidConfigurationError("redis host cannot be empty when Redis is enabled")
        
        # Cast to int to handle env var string values
        try:
            config.redis.port = int(config.redis.port)
            config.redis.db = int(config.redis.db)
            config.redis.metrics_cache_ttl = int(config.redis.metrics_cache_ttl)
            config.redis.allowlist_cache_ttl = int(config.redis.allowlist_cache_ttl)
        except (ValueError, TypeError):
            raise InvalidConfigurationError("Redis numeric configuration values must be integers")
        
        if config.redis.port < 1 or config.redis.port > 65535:
            raise InvalidConfigurationError(
                f"redis port must be between 1 and 65535, got {config.redis.port}"
            )
        
        if config.redis.db < 0:
            raise InvalidConfigurationError(
                f"redis db must be non-negative, got {config.redis.db}"
            )
        
        # Validate SSL configuration
        if config.redis.ssl:
            if not config.redis.ssl_ca_certs:
                raise InvalidConfigurationError(
                    "redis ssl_ca_certs is required when SSL is enabled"
                )
            
            # Client certificate is optional for SSL, but if provided, key must also be provided
            if config.redis.ssl_certfile and not config.redis.ssl_keyfile:
                raise InvalidConfigurationError(
                    "redis ssl_keyfile is required when ssl_certfile is provided"
                )
            
            if config.redis.ssl_keyfile and not config.redis.ssl_certfile:
                raise InvalidConfigurationError(
                    "redis ssl_certfile is required when ssl_keyfile is provided"
                )
        
        # Validate cache TTL values
        if config.redis.metrics_cache_ttl < 1:
            raise InvalidConfigurationError(
                f"redis metrics_cache_ttl must be at least 1, got {config.redis.metrics_cache_ttl}"
            )
        
        if config.redis.allowlist_cache_ttl < 1:
            raise InvalidConfigurationError(
                f"redis allowlist_cache_ttl must be at least 1, got {config.redis.allowlist_cache_ttl}"
            )

    
    # Validate compatibility configuration
    # Note: enable_merkle, enable_redis are just boolean flags - no validation needed
    
    # Validate snapshot configuration (v0.3)
    if config.snapshot.enabled:
        if config.snapshot.retention_days < 1:
            raise InvalidConfigurationError(
                f"snapshot retention_days must be at least 1, got {config.snapshot.retention_days}"
            )
        
        # Validate cron expression format (basic validation)
        if not config.snapshot.schedule_cron:
            raise InvalidConfigurationError("snapshot schedule_cron cannot be empty when snapshots are enabled")
        
        # Cron expression should have 5 fields (minute hour day month weekday)
        cron_fields = config.snapshot.schedule_cron.split()
        if len(cron_fields) != 5:
            raise InvalidConfigurationError(
                f"snapshot schedule_cron must have 5 fields (minute hour day month weekday), "
                f"got {len(cron_fields)} fields: '{config.snapshot.schedule_cron}'"
            )
    
    # Validate allowlist configuration (v0.3)
    if config.allowlist.enabled:
        valid_default_behaviors = ["allow", "deny"]
        if config.allowlist.default_behavior not in valid_default_behaviors:
            raise InvalidConfigurationError(
                f"allowlist default_behavior must be one of {valid_default_behaviors}, "
                f"got '{config.allowlist.default_behavior}'"
            )
        
        if config.allowlist.cache_ttl < 1:
            raise InvalidConfigurationError(
                f"allowlist cache_ttl must be at least 1, got {config.allowlist.cache_ttl}"
            )
        
        if config.allowlist.max_patterns_per_agent < 1:
            raise InvalidConfigurationError(
                f"allowlist max_patterns_per_agent must be at least 1, "
                f"got {config.allowlist.max_patterns_per_agent}"
            )
    
    # Validate event replay configuration (v0.3)
    if config.event_replay.batch_size < 1:
        raise InvalidConfigurationError(
            f"event_replay batch_size must be at least 1, got {config.event_replay.batch_size}"
        )
    
    if config.event_replay.parallelism < 1:
        raise InvalidConfigurationError(
            f"event_replay parallelism must be at least 1, got {config.event_replay.parallelism}"
        )
    
    if config.event_replay.max_replay_duration_hours < 1:
        raise InvalidConfigurationError(
            f"event_replay max_replay_duration_hours must be at least 1, "
            f"got {config.event_replay.max_replay_duration_hours}"
        )
