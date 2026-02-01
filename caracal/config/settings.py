"""
Configuration management for Caracal Core.

Loads YAML configuration from file with sensible defaults and validation.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from caracal.exceptions import ConfigurationError, InvalidConfigurationError


@dataclass
class StorageConfig:
    """Storage configuration for file paths."""
    
    agent_registry: str
    policy_store: str
    ledger: str
    pricebook: str
    backup_dir: str
    backup_count: int = 3


@dataclass
class DefaultsConfig:
    """Default values configuration."""
    
    currency: str = "USD"
    time_window: str = "daily"
    default_budget: float = 100.00


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


def get_default_config_path() -> str:
    """Get the default configuration file path."""
    return os.path.expanduser("~/.caracal/config.yaml")


def get_default_config() -> CaracalConfig:
    """
    Get default configuration with sensible defaults.
    
    Returns:
        CaracalConfig: Default configuration object
    """
    home_dir = os.path.expanduser("~/.caracal")
    
    storage = StorageConfig(
        agent_registry=os.path.join(home_dir, "agents.json"),
        policy_store=os.path.join(home_dir, "policies.json"),
        ledger=os.path.join(home_dir, "ledger.jsonl"),
        pricebook=os.path.join(home_dir, "pricebook.csv"),
        backup_dir=os.path.join(home_dir, "backups"),
        backup_count=3,
    )
    
    defaults = DefaultsConfig(
        currency="USD",
        time_window="daily",
        default_budget=100.00,
    )
    
    logging = LoggingConfig(
        level="INFO",
        file=os.path.join(home_dir, "caracal.log"),
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
        return get_default_config()
    
    # Load YAML file
    try:
        with open(config_path, 'r') as f:
            config_data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise InvalidConfigurationError(
            f"Failed to parse YAML configuration file '{config_path}': {e}"
        )
    except Exception as e:
        raise InvalidConfigurationError(
            f"Failed to read configuration file '{config_path}': {e}"
        )
    
    # If file is empty, return defaults
    if config_data is None:
        return get_default_config()
    
    # Validate and build configuration
    try:
        config = _build_config_from_dict(config_data)
        _validate_config(config)
        return config
    except Exception as e:
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
        pricebook=os.path.expanduser(
            storage_data.get('pricebook', default_config.storage.pricebook)
        ),
        backup_dir=os.path.expanduser(
            storage_data.get('backup_dir', default_config.storage.backup_dir)
        ),
        backup_count=storage_data.get('backup_count', default_config.storage.backup_count),
    )
    
    # Parse defaults configuration (optional)
    defaults_data = config_data.get('defaults', {})
    defaults = DefaultsConfig(
        currency=defaults_data.get('currency', default_config.defaults.currency),
        time_window=defaults_data.get('time_window', default_config.defaults.time_window),
        default_budget=defaults_data.get('default_budget', default_config.defaults.default_budget),
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
    
    return CaracalConfig(
        storage=storage,
        defaults=defaults,
        logging=logging,
        performance=performance,
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
        raise InvalidConfigurationError("agent_registry path cannot be empty")
    if not config.storage.policy_store:
        raise InvalidConfigurationError("policy_store path cannot be empty")
    if not config.storage.ledger:
        raise InvalidConfigurationError("ledger path cannot be empty")
    if not config.storage.pricebook:
        raise InvalidConfigurationError("pricebook path cannot be empty")
    if not config.storage.backup_dir:
        raise InvalidConfigurationError("backup_dir path cannot be empty")
    
    # Validate backup count is positive
    if config.storage.backup_count < 1:
        raise InvalidConfigurationError(
            f"backup_count must be at least 1, got {config.storage.backup_count}"
        )
    
    # Validate currency is not empty
    if not config.defaults.currency:
        raise InvalidConfigurationError("currency cannot be empty")
    
    # Validate time window
    valid_time_windows = ["daily"]  # v0.1 only supports daily
    if config.defaults.time_window not in valid_time_windows:
        raise InvalidConfigurationError(
            f"time_window must be one of {valid_time_windows}, "
            f"got '{config.defaults.time_window}'"
        )
    
    # Validate default budget is positive
    if config.defaults.default_budget <= 0:
        raise InvalidConfigurationError(
            f"default_budget must be positive, got {config.defaults.default_budget}"
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
