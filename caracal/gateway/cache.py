"""
Policy Cache for Gateway Proxy.

Provides caching of policy evaluation results for degraded mode operation
when upstream services are unavailable.
"""

import time
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class PolicyCacheConfig:
    """
    Configuration for the policy cache.

    Attributes:
        max_entries: Maximum number of cached policies
        ttl_seconds: Time-to-live for cache entries in seconds
        cleanup_interval: Interval in seconds for cache cleanup
    """
    max_entries: int = 10000
    ttl_seconds: int = 300
    cleanup_interval: int = 60


@dataclass
class CachedPolicy:
    """
    A cached policy evaluation result.

    Attributes:
        agent_id: The agent this policy applies to
        resource: The resource/action being controlled
        decision: The cached policy decision (allow/deny)
        mandate_id: Associated mandate identifier
        cached_at: Timestamp when the policy was cached
        metadata: Additional policy metadata
    """
    agent_id: str
    resource: str
    decision: str
    mandate_id: Optional[str] = None
    cached_at: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def age_seconds(self) -> float:
        """Return how old this cache entry is in seconds."""
        return time.time() - self.cached_at

    def is_expired(self, ttl_seconds: int) -> bool:
        """Check if this cache entry has expired."""
        return self.age_seconds > ttl_seconds


@dataclass
class CacheStats:
    """
    Statistics about the policy cache.

    Attributes:
        hits: Number of cache hits
        misses: Number of cache misses
        evictions: Number of cache evictions
        total_entries: Current number of entries
        oldest_entry_age: Age of the oldest entry in seconds
    """
    hits: int = 0
    misses: int = 0
    evictions: int = 0
    total_entries: int = 0
    oldest_entry_age: float = 0.0

    @property
    def hit_rate(self) -> float:
        """Return the cache hit rate as a percentage."""
        total = self.hits + self.misses
        if total == 0:
            return 0.0
        return (self.hits / total) * 100.0


class PolicyCache:
    """
    In-memory policy cache for degraded mode operation.

    When upstream authority services are unavailable, the gateway can
    fall back to cached policy decisions to maintain availability.
    """

    def __init__(self, config: Optional[PolicyCacheConfig] = None):
        self.config = config or PolicyCacheConfig()
        self._cache: Dict[str, CachedPolicy] = {}
        self._lock = threading.Lock()
        self._stats = CacheStats()
        logger.info(
            f"PolicyCache initialized: max_entries={self.config.max_entries}, "
            f"ttl={self.config.ttl_seconds}s"
        )

    def get(self, agent_id: str, resource: str) -> Optional[CachedPolicy]:
        """
        Retrieve a cached policy decision.

        Args:
            agent_id: The agent identifier
            resource: The resource/action being requested

        Returns:
            CachedPolicy if found and not expired, None otherwise
        """
        key = self._make_key(agent_id, resource)
        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                self._stats.misses += 1
                return None
            if entry.is_expired(self.config.ttl_seconds):
                del self._cache[key]
                self._stats.misses += 1
                self._stats.evictions += 1
                return None
            self._stats.hits += 1
            return entry

    def put(
        self,
        agent_id: str,
        resource: str,
        decision: str,
        mandate_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CachedPolicy:
        """
        Store a policy decision in the cache.

        Args:
            agent_id: The agent identifier
            resource: The resource/action
            decision: The policy decision
            mandate_id: Optional mandate identifier
            metadata: Optional additional metadata

        Returns:
            The cached policy entry
        """
        key = self._make_key(agent_id, resource)
        entry = CachedPolicy(
            agent_id=agent_id,
            resource=resource,
            decision=decision,
            mandate_id=mandate_id,
            metadata=metadata or {},
        )
        with self._lock:
            # Evict if at capacity
            if len(self._cache) >= self.config.max_entries and key not in self._cache:
                self._evict_oldest()
            self._cache[key] = entry
            self._stats.total_entries = len(self._cache)
        return entry

    def invalidate(self, agent_id: str, resource: Optional[str] = None) -> int:
        """
        Invalidate cached entries for an agent.

        Args:
            agent_id: The agent identifier
            resource: Optional specific resource to invalidate.
                      If None, invalidates all entries for the agent.

        Returns:
            Number of entries invalidated
        """
        count = 0
        with self._lock:
            if resource:
                key = self._make_key(agent_id, resource)
                if key in self._cache:
                    del self._cache[key]
                    count = 1
            else:
                keys_to_remove = [
                    k for k, v in self._cache.items() if v.agent_id == agent_id
                ]
                for k in keys_to_remove:
                    del self._cache[k]
                count = len(keys_to_remove)
            self._stats.total_entries = len(self._cache)
        return count

    def clear(self) -> None:
        """Clear all cached entries."""
        with self._lock:
            self._cache.clear()
            self._stats.total_entries = 0

    def get_stats(self) -> CacheStats:
        """Return current cache statistics."""
        with self._lock:
            self._stats.total_entries = len(self._cache)
            if self._cache:
                oldest = min(e.cached_at for e in self._cache.values())
                self._stats.oldest_entry_age = time.time() - oldest
            else:
                self._stats.oldest_entry_age = 0.0
            return CacheStats(
                hits=self._stats.hits,
                misses=self._stats.misses,
                evictions=self._stats.evictions,
                total_entries=self._stats.total_entries,
                oldest_entry_age=self._stats.oldest_entry_age,
            )

    def cleanup_expired(self) -> int:
        """
        Remove all expired entries from the cache.

        Returns:
            Number of entries removed
        """
        count = 0
        with self._lock:
            expired_keys = [
                k
                for k, v in self._cache.items()
                if v.is_expired(self.config.ttl_seconds)
            ]
            for k in expired_keys:
                del self._cache[k]
                count += 1
            self._stats.evictions += count
            self._stats.total_entries = len(self._cache)
        if count > 0:
            logger.debug(f"Cache cleanup: removed {count} expired entries")
        return count

    def _make_key(self, agent_id: str, resource: str) -> str:
        """Create a cache key from agent_id and resource."""
        return f"{agent_id}:{resource}"

    def _evict_oldest(self) -> None:
        """Evict the oldest cache entry to make room."""
        if not self._cache:
            return
        oldest_key = min(self._cache, key=lambda k: self._cache[k].cached_at)
        del self._cache[oldest_key]
        self._stats.evictions += 1
