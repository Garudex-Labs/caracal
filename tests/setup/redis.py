"""Redis setup utilities for testing."""
import os
from typing import Optional


def get_test_redis_url() -> str:
    """Get test Redis URL from environment or use default."""
    return os.getenv("TEST_REDIS_URL", "redis://localhost:6379/0")


def get_test_redis_config() -> dict:
    """Get test Redis configuration."""
    return {
        "host": os.getenv("TEST_REDIS_HOST", "localhost"),
        "port": int(os.getenv("TEST_REDIS_PORT", "6379")),
        "db": int(os.getenv("TEST_REDIS_DB", "0")),
        "password": os.getenv("TEST_REDIS_PASSWORD"),
        "decode_responses": True,
        "socket_timeout": 5,
        "socket_connect_timeout": 5,
    }


def create_test_redis_client():
    """Create a test Redis client."""
    try:
        import redis
        config = get_test_redis_config()
        return redis.Redis(**config)
    except ImportError:
        # Return None if redis is not installed
        return None


def flush_test_redis(client):
    """Flush test Redis database."""
    if client:
        client.flushdb()


def setup_test_redis(client):
    """Set up test Redis."""
    if client:
        flush_test_redis(client)


def teardown_test_redis(client):
    """Tear down test Redis."""
    if client:
        flush_test_redis(client)
        client.close()
