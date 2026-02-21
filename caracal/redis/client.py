"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Redis client for Caracal Core v0.3.

Provides connection management and basic operations for Redis caching.

"""

import redis
from typing import Optional, Dict, Any, List
from datetime import timedelta

from caracal.logging_config import get_logger
from caracal.exceptions import RedisConnectionError

logger = get_logger(__name__)


class RedisClient:
    """
    Redis client for caching and real-time metrics.
    
    Provides:
    - Connection management with authentication
    - Basic key-value operations
    - Sorted set operations for time-series data
    - TTL management
    - Connection pooling
    
    """
    
    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        password: Optional[str] = None,
        db: int = 0,
        ssl: bool = False,
        ssl_ca_certs: Optional[str] = None,
        ssl_certfile: Optional[str] = None,
        ssl_keyfile: Optional[str] = None,
        socket_timeout: int = 5,
        socket_connect_timeout: int = 5,
        max_connections: int = 50
    ):
        """
        Initialize Redis client.
        
        Args:
            host: Redis server host
            port: Redis server port
            password: Redis password (optional)
            db: Redis database number
            ssl: Enable SSL/TLS
            ssl_ca_certs: Path to CA certificate
            ssl_certfile: Path to client certificate
            ssl_keyfile: Path to client private key
            socket_timeout: Socket timeout in seconds
            socket_connect_timeout: Socket connect timeout in seconds
            max_connections: Maximum connections in pool
        """
        self.host = host
        self.port = port
        self.password = password
        self.db = db
        self.ssl = ssl
        
        # Create connection pool
        pool_kwargs = {
            'host': host,
            'port': port,
            'db': db,
            'password': password,
            'socket_timeout': socket_timeout,
            'socket_connect_timeout': socket_connect_timeout,
            'max_connections': max_connections,
            'decode_responses': True,  # Decode bytes to strings
        }
        
        if ssl:
            pool_kwargs['ssl'] = True
            if ssl_ca_certs:
                pool_kwargs['ssl_ca_certs'] = ssl_ca_certs
            if ssl_certfile:
                pool_kwargs['ssl_certfile'] = ssl_certfile
            if ssl_keyfile:
                pool_kwargs['ssl_keyfile'] = ssl_keyfile
        
        self._pool = redis.ConnectionPool(**pool_kwargs)
        self._client = redis.Redis(connection_pool=self._pool)
        
        logger.info(
            f"Redis client initialized: host={host}, port={port}, "
            f"db={db}, ssl={ssl}"
        )
    
    def ping(self) -> bool:
        """
        Ping Redis server to check connectivity.
        
        Returns:
            True if connected, False otherwise
        """
        try:
            return self._client.ping()
        except redis.RedisError as e:
            logger.error(f"Redis ping failed: {e}")
            return False
    
    def get(self, key: str) -> Optional[str]:
        """
        Get value by key.
        
        Args:
            key: Redis key
            
        Returns:
            Value as string, or None if key doesn't exist
        """
        try:
            return self._client.get(key)
        except redis.RedisError as e:
            logger.error(f"Redis GET failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to get key {key}: {e}") from e
    
    def set(
        self,
        key: str,
        value: str,
        ex: Optional[int] = None,
        px: Optional[int] = None,
        nx: bool = False,
        xx: bool = False
    ) -> bool:
        """
        Set key to value.
        
        Args:
            key: Redis key
            value: Value to set
            ex: Expiration time in seconds
            px: Expiration time in milliseconds
            nx: Only set if key doesn't exist
            xx: Only set if key exists
            
        Returns:
            True if set successfully, False otherwise
        """
        try:
            return self._client.set(key, value, ex=ex, px=px, nx=nx, xx=xx)
        except redis.RedisError as e:
            logger.error(f"Redis SET failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to set key {key}: {e}") from e
    
    def delete(self, *keys: str) -> int:
        """
        Delete one or more keys.
        
        Args:
            keys: Keys to delete
            
        Returns:
            Number of keys deleted
        """
        try:
            return self._client.delete(*keys)
        except redis.RedisError as e:
            logger.error(f"Redis DELETE failed: {e}")
            raise RedisConnectionError(f"Failed to delete keys: {e}") from e
    
    def exists(self, *keys: str) -> int:
        """
        Check if keys exist.
        
        Args:
            keys: Keys to check
            
        Returns:
            Number of keys that exist
        """
        try:
            return self._client.exists(*keys)
        except redis.RedisError as e:
            logger.error(f"Redis EXISTS failed: {e}")
            raise RedisConnectionError(f"Failed to check key existence: {e}") from e
    
    def expire(self, key: str, seconds: int) -> bool:
        """
        Set expiration time for key.
        
        Args:
            key: Redis key
            seconds: Expiration time in seconds
            
        Returns:
            True if expiration set, False if key doesn't exist
        """
        try:
            return self._client.expire(key, seconds)
        except redis.RedisError as e:
            logger.error(f"Redis EXPIRE failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to set expiration for key {key}: {e}") from e
    
    def ttl(self, key: str) -> int:
        """
        Get time to live for key.
        
        Args:
            key: Redis key
            
        Returns:
            TTL in seconds, -1 if no expiration, -2 if key doesn't exist
        """
        try:
            return self._client.ttl(key)
        except redis.RedisError as e:
            logger.error(f"Redis TTL failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to get TTL for key {key}: {e}") from e
    
    def incr(self, key: str, amount: int = 1) -> int:
        """
        Increment key by amount.
        
        Args:
            key: Redis key
            amount: Amount to increment by
            
        Returns:
            New value after increment
        """
        try:
            return self._client.incr(key, amount)
        except redis.RedisError as e:
            logger.error(f"Redis INCR failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to increment key {key}: {e}") from e
    
    def incrbyfloat(self, key: str, amount: float) -> float:
        """
        Increment key by float amount.
        
        Args:
            key: Redis key
            amount: Amount to increment by
            
        Returns:
            New value after increment
        """
        try:
            return float(self._client.incrbyfloat(key, amount))
        except redis.RedisError as e:
            logger.error(f"Redis INCRBYFLOAT failed for key {key}: {e}")
            raise RedisConnectionError(f"Failed to increment key {key}: {e}") from e
    
    def hget(self, name: str, key: str) -> Optional[str]:
        """
        Get value from hash.
        
        Args:
            name: Hash name
            key: Hash key
            
        Returns:
            Value as string, or None if key doesn't exist
        """
        try:
            return self._client.hget(name, key)
        except redis.RedisError as e:
            logger.error(f"Redis HGET failed for hash {name}, key {key}: {e}")
            raise RedisConnectionError(f"Failed to get hash value: {e}") from e
    
    def hset(self, name: str, key: str, value: str) -> int:
        """
        Set value in hash.
        
        Args:
            name: Hash name
            key: Hash key
            value: Value to set
            
        Returns:
            1 if new field, 0 if field updated
        """
        try:
            return self._client.hset(name, key, value)
        except redis.RedisError as e:
            logger.error(f"Redis HSET failed for hash {name}, key {key}: {e}")
            raise RedisConnectionError(f"Failed to set hash value: {e}") from e
    
    def hgetall(self, name: str) -> Dict[str, str]:
        """
        Get all fields and values from hash.
        
        Args:
            name: Hash name
            
        Returns:
            Dictionary of field-value pairs
        """
        try:
            return self._client.hgetall(name)
        except redis.RedisError as e:
            logger.error(f"Redis HGETALL failed for hash {name}: {e}")
            raise RedisConnectionError(f"Failed to get hash: {e}") from e
    
    def hincrby(self, name: str, key: str, amount: int = 1) -> int:
        """
        Increment hash field by amount.
        
        Args:
            name: Hash name
            key: Hash key
            amount: Amount to increment by
            
        Returns:
            New value after increment
        """
        try:
            return self._client.hincrby(name, key, amount)
        except redis.RedisError as e:
            logger.error(f"Redis HINCRBY failed for hash {name}, key {key}: {e}")
            raise RedisConnectionError(f"Failed to increment hash field: {e}") from e
    
    def hincrbyfloat(self, name: str, key: str, amount: float) -> float:
        """
        Increment hash field by float amount.
        
        Args:
            name: Hash name
            key: Hash key
            amount: Amount to increment by
            
        Returns:
            New value after increment
        """
        try:
            return float(self._client.hincrbyfloat(name, key, amount))
        except redis.RedisError as e:
            logger.error(f"Redis HINCRBYFLOAT failed for hash {name}, key {key}: {e}")
            raise RedisConnectionError(f"Failed to increment hash field: {e}") from e
    
    def zadd(
        self,
        name: str,
        mapping: Dict[str, float],
        nx: bool = False,
        xx: bool = False,
        gt: bool = False,
        lt: bool = False
    ) -> int:
        """
        Add members to sorted set.
        
        Args:
            name: Sorted set name
            mapping: Dictionary of member-score pairs
            nx: Only add new members
            xx: Only update existing members
            gt: Only update if new score is greater
            lt: Only update if new score is less
            
        Returns:
            Number of members added
        """
        try:
            return self._client.zadd(name, mapping, nx=nx, xx=xx, gt=gt, lt=lt)
        except redis.RedisError as e:
            logger.error(f"Redis ZADD failed for sorted set {name}: {e}")
            raise RedisConnectionError(f"Failed to add to sorted set: {e}") from e
    
    def zrange(
        self,
        name: str,
        start: int,
        end: int,
        withscores: bool = False
    ) -> List:
        """
        Get range of members from sorted set by index.
        
        Args:
            name: Sorted set name
            start: Start index
            end: End index
            withscores: Include scores in result
            
        Returns:
            List of members (or member-score tuples if withscores=True)
        """
        try:
            return self._client.zrange(name, start, end, withscores=withscores)
        except redis.RedisError as e:
            logger.error(f"Redis ZRANGE failed for sorted set {name}: {e}")
            raise RedisConnectionError(f"Failed to get range from sorted set: {e}") from e
    
    def zrangebyscore(
        self,
        name: str,
        min_score: float,
        max_score: float,
        withscores: bool = False
    ) -> List:
        """
        Get range of members from sorted set by score.
        
        Args:
            name: Sorted set name
            min_score: Minimum score
            max_score: Maximum score
            withscores: Include scores in result
            
        Returns:
            List of members (or member-score tuples if withscores=True)
        """
        try:
            return self._client.zrangebyscore(
                name, min_score, max_score, withscores=withscores
            )
        except redis.RedisError as e:
            logger.error(f"Redis ZRANGEBYSCORE failed for sorted set {name}: {e}")
            raise RedisConnectionError(f"Failed to get range from sorted set: {e}") from e
    
    def zremrangebyscore(
        self,
        name: str,
        min_score: float,
        max_score: float
    ) -> int:
        """
        Remove members from sorted set by score range.
        
        Args:
            name: Sorted set name
            min_score: Minimum score
            max_score: Maximum score
            
        Returns:
            Number of members removed
        """
        try:
            return self._client.zremrangebyscore(name, min_score, max_score)
        except redis.RedisError as e:
            logger.error(f"Redis ZREMRANGEBYSCORE failed for sorted set {name}: {e}")
            raise RedisConnectionError(f"Failed to remove from sorted set: {e}") from e
    
    def close(self):
        """Close Redis connection pool."""
        if self._pool:
            self._pool.disconnect()
            logger.info("Redis connection pool closed")
