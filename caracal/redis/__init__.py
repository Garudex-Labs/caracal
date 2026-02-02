"""
Redis client and caching components for Caracal Core v0.3.

This module provides Redis clients for caching and real-time metrics.
"""

from caracal.redis.client import RedisClient
from caracal.redis.spending_cache import RedisSpendingCache

__all__ = [
    "RedisClient",
    "RedisSpendingCache",
]
