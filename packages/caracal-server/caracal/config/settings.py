"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Configuration management for Caracal Core.

Loads YAML configuration from file with sensible defaults and validation.
Supports environment variable substitution using ${ENV_VAR} syntax.
Supports encrypted configuration values using ENC[v4:...] syntax.
"""
import os
import re
from datetime import datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from caracal.exceptions import InvalidConfigurationError
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
    
    Encrypted values use the format: ENC[v4:...].
    Decryption resolves vault-backed secret references.
    
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
        
        # Initialize encryptor using local keystore-backed key hierarchy.
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
            "Ensure vault configuration is present and reachable."
        )


_LEGACY_ENV_PLACEHOLDER_RENAMES = {
    "CARACAL_HOME": "CCL_HOME",
    "CARACAL_DB_HOST": "CCL_DB_HOST",
    "CARACAL_DB_PORT": "CCL_DB_PORT",
    "CARACAL_DB_NAME": "CCL_DB_NAME",
    "CARACAL_DB_USER": "CCL_DB_USER",
    "CARACAL_DB_PASSWORD": "CCL_DB_PASSWORD",
    "CARACAL_DB_POOL_SIZE": "CCL_DB_POOL_SIZE",
    "CARACAL_DB_MAX_OVERFLOW": "CCL_DB_MAX_OVERFLOW",
    "CARACAL_DB_POOL_TIMEOUT": "CCL_DB_POOL_TTL",
    "CARACAL_MCP_LISTEN_ADDRESS": "CCL_MCP_LISTEN_ADDR",
    "CARACAL_VAULT_MERKLE_SIGNING_KEY_REF": "CCL_VAULT_MERKLE_SIGNING_KEY_REF",
    "CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF": "CCL_VAULT_MERKLE_PUB_KEY_REF",
}


def _rewrite_legacy_env_placeholders(value: Any) -> tuple[Any, bool]:
    """Rewrite legacy config placeholders before env expansion."""
    if isinstance(value, str):
        rewritten = value
        for old_name, new_name in _LEGACY_ENV_PLACEHOLDER_RENAMES.items():
            rewritten = re.sub(
                rf"\$\{{{re.escape(old_name)}(?=[:}}])",
                "${" + new_name,
                rewritten,
            )
        return rewritten, rewritten != value

    if isinstance(value, dict):
        changed = False
        rewritten_dict: dict[Any, Any] = {}
        for key, item in value.items():
            rewritten_item, item_changed = _rewrite_legacy_env_placeholders(item)
            rewritten_dict[key] = rewritten_item
            changed = changed or item_changed
        return rewritten_dict, changed

    if isinstance(value, list):
        changed = False
        rewritten_list: list[Any] = []
        for item in value:
            rewritten_item, item_changed = _rewrite_legacy_env_placeholders(item)
            rewritten_list.append(rewritten_item)
            changed = changed or item_changed
        return rewritten_list, changed

    return value, False


def _normalize_legacy_config_data(config_data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
    """Normalize persisted pre-CCL config defaults."""
    if not isinstance(config_data, dict):
        return config_data, False

    normalized, changed = _rewrite_legacy_env_placeholders(config_data)
    if not isinstance(normalized, dict):
        return config_data, changed

    mcp_adapter = normalized.get("mcp_adapter")
    if isinstance(mcp_adapter, dict):
        servers = mcp_adapter.get("mcp_server_urls")
        if (
            isinstance(servers, list)
            and len(servers) == 1
            and isinstance(servers[0], dict)
            and servers[0].get("name") == "demo-upstream"
            and servers[0].get("url") == "http://host.docker.internal:8090"
        ):
            normalized = dict(normalized)
            normalized_mcp = dict(mcp_adapter)
            normalized_mcp["mcp_server_urls"] = []
            normalized["mcp_adapter"] = normalized_mcp
            changed = True

    return normalized, changed


def _has_encrypted_values(value: Any) -> bool:
    """
    Check if configuration contains any encrypted values.
    
    Args:
        value: Configuration value (string, dict, list, or other)
    
    Returns:
        True if any encrypted values found, False otherwise
    """
    if isinstance(value, str):
        return value.startswith("ENC[v") and value.endswith("]")
    elif isinstance(value, dict):
        return any(_has_encrypted_values(v) for v in value.values())
    elif isinstance(value, list):
        return any(_has_encrypted_values(item) for item in value)
    else:
        return False


@dataclass
class StorageConfig:
    """Storage configuration for workspace-local operational data."""
    
    backup_dir: str
    backup_count: int = 3


@dataclass
class DatabaseConfig:
    """PostgreSQL database configuration.

    PostgreSQL is the only supported backend.  Values may be overridden
    via ``CCL_DB_*`` environment variables (handled in
    ``caracal.db.connection``).
    """

    host: str = "localhost"
    port: int = 5432
    database: str = "caracal"
    user: str = "caracal"
    password: str = ""
    schema: str = ""  # PostgreSQL schema for workspace isolation
    pool_size: int = 10
    max_overflow: int = 5
    pool_timeout: int = 30

    def get_connection_url(self) -> str:
        """Build a PostgreSQL connection URL."""
        from urllib.parse import quote_plus
        return f"postgresql://{self.user}:{quote_plus(self.password)}@{self.host}:{self.port}/{self.database}"


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
    listen_address: str = ""
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
    default_behavior: str = "deny"  # "allow" or "deny" when no allowlist defined
    cache_ttl: int = 60  # Cache compiled patterns for 60 seconds
    max_patterns_per_principal: int = 1000


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
    signing_backend: str = "software"  # "software", "vault", or "hsm" (Enterprise only)
    private_key_path: str = ""  # Path to private key for software signing
    vault_key_ref: str = ""  # Vault private signing key reference for hard-cut mode
    vault_public_key_ref: str = ""  # Vault public verification key reference
    key_encryption_passphrase: str = ""  # Passphrase for encrypted key (from env var)
    key_rotation_enabled: bool = False  # Enable automatic key rotation
    key_rotation_days: int = 90  # Rotate keys every 90 days
    # HSM configuration (Enterprise only, ignored if signing_backend=software)
    hsm_config: dict = field(default_factory=dict)


@dataclass
class CompatibilityConfig:
    """Infrastructure compatibility flags.

    Redis caching and Merkle integrity are mandatory in current Caracal
    deployments. These fields are retained only for backward compatibility
    with older config files.
    """

    enable_merkle: bool = True
    enable_redis: bool = True


@dataclass
class AuthorityEnforcementConfig:
    """Authority enforcement feature flags for gradual rollout."""
    
    enabled: bool = False  # Global authority enforcement flag
    per_principal_rollout: bool = False  # Enable per-principal authority enforcement
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
    workspace = get_workspace()
    workspace.ensure_dirs()

    storage = StorageConfig(
        backup_dir=str(workspace.backups_dir),
        backup_count=3,
    )
    
    defaults = DefaultsConfig(
        time_window="daily",
    )
    
    logging = LoggingConfig(
        level="INFO",
        file=str(workspace.log_path),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    
    performance = PerformanceConfig(
        policy_eval_timeout_ms=100,
        ledger_write_timeout_ms=10,
        file_lock_timeout_s=5,
        max_retries=3,
    )
    
    cfg = CaracalConfig(
        storage=storage,
        defaults=defaults,
        logging=logging,
        performance=performance,
    )

    cfg.compatibility.enable_redis = True
    cfg.compatibility.enable_merkle = True
    cfg.merkle.signing_backend = "vault"
    cfg.merkle.vault_key_ref = os.environ.get("CCL_VAULT_MERKLE_SIGNING_KEY_REF", "")
    cfg.merkle.vault_public_key_ref = os.environ.get("CCL_VAULT_MERKLE_PUB_KEY_REF", "")
    return cfg


def load_config(
    config_path: Optional[str] = None,
    suppress_missing_file_log: bool = False,
    emit_logs: bool = True,
) -> CaracalConfig:
    """
    Load configuration from YAML file with validation.
    
    If config file is not found, returns default configuration.
    If config file is malformed or invalid, raises ConfigurationError.
    
    Args:
        config_path: Path to configuration file. If None, uses default path.
        suppress_missing_file_log: If True, do not emit info logs when config
            file is missing and defaults are used.
    
    Returns:
        CaracalConfig: Loaded and validated configuration
    
    Raises:
        InvalidConfigurationError: If configuration is invalid or malformed
    """
    if config_path is None:
        config_path = get_default_config_path()
    
    # Expand user home directory
    config_path = os.path.expanduser(config_path)

    # If caller points to a workspace config.yaml, align runtime workspace
    # context so all workspace-local paths (backup/log/cache/keys) resolve
    # to that workspace instead of the process default.
    try:
        cfg_path_obj = Path(config_path)
        if cfg_path_obj.name == "config.yaml":
            from caracal.flow.workspace import set_workspace
            set_workspace(cfg_path_obj.parent)
    except Exception:
        pass
    
    # If config file doesn't exist, return defaults
    if not os.path.exists(config_path):
        if emit_logs and not suppress_missing_file_log:
            logger.info(f"Configuration file not found at {config_path}, using defaults")
        return get_default_config()
    
    try:
        with open(config_path, 'r') as f:
            config_data = yaml.safe_load(f)
        if emit_logs:
            logger.debug(f"Loaded configuration from {config_path}")
    except yaml.YAMLError as e:
        if _attempt_legacy_workspace_config_repair(config_path):
            try:
                with open(config_path, 'r') as f:
                    config_data = yaml.safe_load(f)
                logger.warning(
                    "Auto-repaired malformed workspace config and retried load",
                    config_path=config_path,
                )
            except Exception:
                logger.error(f"Failed to parse YAML configuration file '{config_path}': {e}", exc_info=True)
                raise InvalidConfigurationError(
                    f"Failed to parse YAML configuration file '{config_path}': {e}"
                )
        else:
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
        if emit_logs:
            logger.info(f"Configuration file {config_path} is empty, using defaults")
        return get_default_config()

    config_data, legacy_normalized = _normalize_legacy_config_data(config_data)
    if legacy_normalized:
        _persist_normalized_workspace_config(config_path, config_data)
        if emit_logs:
            logger.info(
                "Normalized legacy config placeholders",
                config_path=config_path,
            )
    
    # Expand environment variables in configuration
    config_data = _expand_env_vars(config_data)
    if emit_logs:
        logger.debug("Expanded environment variables in configuration")
    
    # Decrypt encrypted configuration values
    config_data = _decrypt_config_values(config_data)
    if emit_logs:
        logger.debug("Decrypted encrypted configuration values")

    # Shared hard-cut normalization for all callers (CLI, runtime, Flow).
    config_data, normalized = _normalize_hardcut_merkle_config_data(config_data)
    if normalized:
        _persist_normalized_workspace_config(config_path, config_data)
        if emit_logs:
            logger.info(
                "Normalized Merkle config to hard-cut vault mode",
                config_path=config_path,
            )
    
    # Validate and build configuration
    try:
        config = _build_config_from_dict(config_data)
        _validate_config(config)
        if emit_logs:
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
        backup_dir=os.path.expanduser(
            storage_data.get('backup_dir') or default_config.storage.backup_dir
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
            logging_data.get('file') or default_config.logging.file
        ),
        format=logging_data.get('format', default_config.logging.format),
    )

    from caracal.flow.workspace import get_workspace
    workspace = get_workspace()
    workspace.ensure_dirs()

    # Enforce workspace-local operational paths.
    expected_backup_dir = str(workspace.backups_dir)
    expected_log_file = str(workspace.log_path)
    if Path(storage.backup_dir).expanduser() != workspace.backups_dir:
        logger.warning(
            "Overriding storage.backup_dir to workspace path",
            configured=storage.backup_dir,
            enforced=expected_backup_dir,
        )
        storage.backup_dir = expected_backup_dir
    if Path(logging.file).expanduser() != workspace.log_path:
        logger.warning(
            "Overriding logging.file to workspace logs directory",
            configured=logging.file,
            enforced=expected_log_file,
        )
        logging.file = expected_log_file
    
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
    
    # Parse database configuration (PostgreSQL only)
    database_data = config_data.get('database', {})
    database = DatabaseConfig(
        host=database_data.get('host', default_config.database.host),
        port=database_data.get('port', default_config.database.port),
        database=database_data.get('database', default_config.database.database),
        user=database_data.get('user', default_config.database.user),
        password=database_data.get('password', default_config.database.password),
        schema=database_data.get('schema', default_config.database.schema),
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
        
    # Parse Merkle configuration (optional, for v0.3)
    merkle_data = config_data.get('merkle', {})
    merkle = MerkleConfig(
        batch_size_limit=merkle_data.get('batch_size_limit', default_config.merkle.batch_size_limit),
        batch_timeout_seconds=merkle_data.get('batch_timeout_seconds', default_config.merkle.batch_timeout_seconds),
        signing_algorithm=merkle_data.get('signing_algorithm', default_config.merkle.signing_algorithm),
        signing_backend=merkle_data.get('signing_backend', default_config.merkle.signing_backend),
        private_key_path=os.path.expanduser(merkle_data.get('private_key_path', default_config.merkle.private_key_path)),
        vault_key_ref=merkle_data.get('vault_key_ref', default_config.merkle.vault_key_ref),
        vault_public_key_ref=merkle_data.get('vault_public_key_ref', default_config.merkle.vault_public_key_ref),
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
        max_patterns_per_principal=allowlist_data.get(
            'max_patterns_per_principal', default_config.allowlist.max_patterns_per_principal,
        ),
    )
    
    # Parse event replay configuration
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
        enable_merkle=True,
        enable_redis=True,
    )
    
    # Parse authority enforcement configuration
    authority_enforcement_data = config_data.get('authority_enforcement', {})
    authority_enforcement = AuthorityEnforcementConfig(
        enabled=authority_enforcement_data.get('enabled', default_config.authority_enforcement.enabled),
        per_principal_rollout=authority_enforcement_data.get('per_principal_rollout', default_config.authority_enforcement.per_principal_rollout),
        compatibility_logging_enabled=authority_enforcement_data.get('compatibility_logging_enabled', default_config.authority_enforcement.compatibility_logging_enabled),
    )
    
    # Redis and Merkle are mandatory. We still preserve compatibility fields
    # in-memory for legacy code paths, but they are always forced on.
    _ = compatibility_data  # Parsed to tolerate legacy config keys.

    if merkle.signing_backend == "software":
        if not merkle.private_key_path:
            from caracal.flow.workspace import get_workspace

            workspace = get_workspace()
            workspace.ensure_dirs()
            merkle.private_key_path = str(workspace.keys_dir / "merkle_signing_key.pem")

    # Log warnings for authority enforcement configuration
    if authority_enforcement.enabled:
        logger.info("Authority enforcement enabled")
        if authority_enforcement.per_principal_rollout:
            logger.info("Per-principal authority enforcement rollout enabled")
        if authority_enforcement.compatibility_logging_enabled:
            logger.info("Compatibility logging enabled for authority enforcement")
    
    return CaracalConfig(
        storage=storage,
        defaults=defaults,
        logging=logging,
        performance=performance,
        database=database,
        gateway=gateway,
        policy_cache=policy_cache,
        mcp_adapter=mcp_adapter,
        redis=redis,
        merkle=merkle,
        snapshot=snapshot,
        allowlist=allowlist,
        event_replay=event_replay,
        compatibility=compatibility,
        authority_enforcement=authority_enforcement,
    )



def _attempt_legacy_workspace_config_repair(config_path: str) -> bool:
    """Repair known malformed onboarding YAML files in workspace directories.

    Returns True when a repair was applied.
    """
    cfg = Path(config_path).expanduser()
    if cfg.name != "config.yaml":
        return False

    workspace_dir = cfg.parent
    if workspace_dir.name == ".caracal" or workspace_dir.parent.name != "workspaces":
        return False

    try:
        original = cfg.read_text()
    except Exception:
        return False

    # Limit repair to onboarding-generated files we can confidently regenerate.
    if "Caracal Core Configuration" not in original:
        return False

    try:
        backup = cfg.with_suffix(f".yaml.broken.{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}")
        backup.write_text(original)

        repaired = {
            "storage": {
                "backup_dir": str(workspace_dir / "backups"),
                "backup_count": 3,
            },
            "defaults": {
                "time_window": "daily",
            },
            "logging": {
                "level": "INFO",
                "file": str(workspace_dir / "logs" / "caracal.log"),
            },
            "redis": {
                "host": "localhost",
                "port": 6379,
                "db": 0,
            },
            "merkle": {
                "signing_backend": "vault",
                "signing_algorithm": "ES256",
                "vault_key_ref": os.environ.get("CCL_VAULT_MERKLE_SIGNING_KEY_REF", ""),
                "vault_public_key_ref": os.environ.get("CCL_VAULT_MERKLE_PUB_KEY_REF", ""),
            },
        }

        with open(cfg, "w") as f:
            f.write("# Caracal Core Configuration\n\n")
            yaml.safe_dump(repaired, f, default_flow_style=False, sort_keys=False)
        return True
    except Exception:
        return False


def _normalize_hardcut_merkle_config_data(
    config_data: Dict[str, Any],
) -> tuple[Dict[str, Any], bool]:
    """Normalize legacy Merkle config fields for hard-cut runtime mode."""
    if not isinstance(config_data, dict):
        return config_data, False

    updated = dict(config_data)
    merkle_data = updated.get("merkle")
    if not isinstance(merkle_data, dict):
        merkle_data = {}

    normalized_merkle = dict(merkle_data)
    changed = False

    if normalized_merkle.get("signing_backend") != "vault":
        normalized_merkle["signing_backend"] = "vault"
        changed = True

    if not normalized_merkle.get("signing_algorithm"):
        normalized_merkle["signing_algorithm"] = "ES256"
        changed = True

    if not normalized_merkle.get("vault_key_ref"):
        normalized_merkle["vault_key_ref"] = os.environ.get("CCL_VAULT_MERKLE_SIGNING_KEY_REF", "")
        changed = True

    if not normalized_merkle.get("vault_public_key_ref"):
        normalized_merkle["vault_public_key_ref"] = os.environ.get("CCL_VAULT_MERKLE_PUB_KEY_REF", "")
        changed = True

    if "private_key_path" in normalized_merkle:
        normalized_merkle.pop("private_key_path", None)
        changed = True

    if changed:
        updated["merkle"] = normalized_merkle

    return updated, changed


def _persist_normalized_workspace_config(config_path: str, config_data: Dict[str, Any]) -> None:
    """Best-effort write-back of normalized workspace config."""
    cfg = Path(config_path).expanduser()
    if cfg.name != "config.yaml" or not cfg.exists():
        return

    try:
        with open(cfg, "w") as f:
            yaml.safe_dump(config_data, f, default_flow_style=False, sort_keys=False)
    except Exception:
        return


def _validate_config(config: CaracalConfig) -> None:
    """
    Validate configuration values.
    
    Args:
        config: Configuration to validate
    
    Raises:
        InvalidConfigurationError: If configuration is invalid
    """
    # Validate backup settings (used for exports/snapshots, independent of DB backend)
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
    
    # Validate database configuration 
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
    
    # Validate gateway configuration 
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
    
    # Validate policy cache configuration 
    if config.policy_cache.enabled:
        if config.policy_cache.ttl_seconds <= 0:
            raise InvalidConfigurationError(
                f"policy_cache ttl_seconds must be positive, got {config.policy_cache.ttl_seconds}"
            )
        if config.policy_cache.max_size < 1:
            raise InvalidConfigurationError(
                f"policy_cache max_size must be at least 1, got {config.policy_cache.max_size}"
            )
    
    # Validate MCP adapter configuration 
    if config.mcp_adapter.enabled:
        if not config.mcp_adapter.listen_address:
            raise InvalidConfigurationError("mcp_adapter listen_address cannot be empty when MCP adapter is enabled")
        
    # Enforce mandatory services regardless of legacy compatibility toggles.
    config.compatibility.enable_merkle = True
    config.compatibility.enable_redis = True
    # Validate Merkle configuration (mandatory)
    if config.merkle.signing_backend != "vault":
        raise InvalidConfigurationError(
            "merkle signing_backend must be 'vault'. "
            "Local file-backed Merkle signing is forbidden."
        )
    if config.merkle.signing_backend == "vault":
        if not config.merkle.vault_key_ref:
            raise InvalidConfigurationError(
                "merkle vault_key_ref is required when signing_backend is 'vault'"
            )
        if not config.merkle.vault_public_key_ref:
            raise InvalidConfigurationError(
                "merkle vault_public_key_ref is required when signing_backend is 'vault'"
            )

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

    valid_signing_backends = ["software", "vault", "hsm"]
    if config.merkle.signing_backend not in valid_signing_backends:
        raise InvalidConfigurationError(
            f"merkle signing_backend must be one of {valid_signing_backends}, "
            f"got '{config.merkle.signing_backend}'"
        )

    # Validate key rotation configuration
    if config.merkle.key_rotation_enabled:
        if config.merkle.key_rotation_days < 1:
            raise InvalidConfigurationError(
                f"merkle key_rotation_days must be at least 1, got {config.merkle.key_rotation_days}"
            )
    
    # Validate Redis configuration (mandatory)
    if not config.redis.host:
        raise InvalidConfigurationError("redis host cannot be empty")

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
    # Compatibility toggles are retained only for legacy config parsing.
    
    # Validate snapshot configuration 
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
    
    # Validate allowlist configuration 
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
        
        if config.allowlist.max_patterns_per_principal < 1:
            raise InvalidConfigurationError(
                f"allowlist max_patterns_per_principal must be at least 1, "
                f"got {config.allowlist.max_patterns_per_principal}"
            )
    
    # Validate event replay configuration 
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
