"""Environment setup utilities for testing."""
import os
from typing import Dict, Any, Optional


def set_test_environment():
    """Set up test environment variables."""
    test_env = {
        "CARACAL_ENV": "test",
        "CARACAL_DEBUG": "true",
        "CARACAL_LOG_LEVEL": "DEBUG",
        "DATABASE_URL": "postgresql://test:test@localhost:5432/caracal_test",
        "REDIS_URL": "redis://localhost:6379/0",
        "SECRET_KEY": "test-secret-key-not-for-production",
    }
    
    for key, value in test_env.items():
        if key not in os.environ:
            os.environ[key] = value


def clear_test_environment():
    """Clear test environment variables."""
    test_keys = [
        "CARACAL_ENV",
        "CARACAL_DEBUG",
        "CARACAL_LOG_LEVEL",
        "DATABASE_URL",
        "REDIS_URL",
        "SECRET_KEY",
    ]
    
    for key in test_keys:
        os.environ.pop(key, None)


def get_test_config() -> Dict[str, Any]:
    """Get test configuration."""
    return {
        "database_url": os.getenv("DATABASE_URL", "postgresql://test:test@localhost:5432/caracal_test"),
        "redis_url": os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        "secret_key": os.getenv("SECRET_KEY", "test-secret-key"),
        "debug": os.getenv("CARACAL_DEBUG", "true").lower() == "true",
        "log_level": os.getenv("CARACAL_LOG_LEVEL", "DEBUG"),
    }


def override_config(overrides: Dict[str, Any]):
    """Override configuration with custom values."""
    for key, value in overrides.items():
        env_key = key.upper()
        os.environ[env_key] = str(value)
