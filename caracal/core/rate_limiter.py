"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Rate limiting for mandate issuance.

Provides rate limiting functionality to prevent abuse and ensure
fair resource allocation across principals.

Requirements: 14.9
"""

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from caracal.redis.client import RedisClient
from caracal.logging_config import get_logger
from caracal.exceptions import RateLimitExceededError

logger = get_logger(__name__)


class MandateIssuanceRateLimiter:
    """
    Rate limiter for mandate issuance operations.
    
    Tracks issuance requests per principal and enforces configurable
    rate limits using Redis for distributed rate limiting.
    
    Uses sliding window algorithm for accurate rate limiting.
    
    Requirements: 14.9
    """
    
    # Key prefix
    PREFIX_RATE_LIMIT = "caracal:rate_limit:mandate_issuance"
    
    # Default rate limits
    DEFAULT_LIMIT_PER_HOUR = 100
    DEFAULT_LIMIT_PER_MINUTE = 10
    
    def __init__(
        self,
        redis_client: RedisClient,
        limit_per_hour: int = DEFAULT_LIMIT_PER_HOUR,
        limit_per_minute: int = DEFAULT_LIMIT_PER_MINUTE
    ):
        """
        Initialize rate limiter.
        
        Args:
            redis_client: RedisClient instance
            limit_per_hour: Maximum issuance requests per hour per principal
            limit_per_minute: Maximum issuance requests per minute per principal
        """
        self.redis = redis_client
        self.limit_per_hour = limit_per_hour
        self.limit_per_minute = limit_per_minute
        
        logger.info(
            f"MandateIssuanceRateLimiter initialized: "
            f"limit_per_hour={limit_per_hour}, limit_per_minute={limit_per_minute}"
        )
    
    def _get_rate_limit_key(self, principal_id: UUID, window: str) -> str:
        """
        Get Redis key for rate limit tracking.
        
        Args:
            principal_id: Principal identifier
            window: Time window ('hour' or 'minute')
        
        Returns:
            Redis key string
        """
        return f"{self.PREFIX_RATE_LIMIT}:{principal_id}:{window}"
    
    def check_rate_limit(self, principal_id: UUID) -> None:
        """
        Check if principal has exceeded rate limit.
        
        Uses sliding window algorithm with sorted sets:
        - Stores timestamps of requests in sorted set
        - Removes expired timestamps
        - Counts remaining timestamps
        - Compares against limit
        
        Args:
            principal_id: Principal identifier
        
        Raises:
            RateLimitExceededError: If rate limit is exceeded
        
        Requirements: 14.9
        """
        current_time = datetime.utcnow()
        current_timestamp = current_time.timestamp()
        
        # Check hourly limit
        self._check_window_limit(
            principal_id=principal_id,
            window="hour",
            limit=self.limit_per_hour,
            window_seconds=3600,
            current_timestamp=current_timestamp
        )
        
        # Check per-minute limit
        self._check_window_limit(
            principal_id=principal_id,
            window="minute",
            limit=self.limit_per_minute,
            window_seconds=60,
            current_timestamp=current_timestamp
        )
        
        logger.debug(f"Rate limit check passed for principal {principal_id}")
    
    def _check_window_limit(
        self,
        principal_id: UUID,
        window: str,
        limit: int,
        window_seconds: int,
        current_timestamp: float
    ) -> None:
        """
        Check rate limit for a specific time window.
        
        Args:
            principal_id: Principal identifier
            window: Window name ('hour' or 'minute')
            limit: Maximum requests in window
            window_seconds: Window size in seconds
            current_timestamp: Current Unix timestamp
        
        Raises:
            RateLimitExceededError: If rate limit is exceeded
        """
        try:
            key = self._get_rate_limit_key(principal_id, window)
            
            # Remove expired timestamps (older than window)
            min_timestamp = current_timestamp - window_seconds
            self.redis.zremrangebyscore(key, 0, min_timestamp)
            
            # Count requests in current window
            count = self.redis._client.zcard(key)
            
            if count >= limit:
                # Rate limit exceeded
                error_msg = (
                    f"Rate limit exceeded for principal {principal_id}: "
                    f"{count} requests in last {window} (limit: {limit})"
                )
                logger.warning(error_msg)
                raise RateLimitExceededError(error_msg)
            
            logger.debug(
                f"Rate limit check for principal {principal_id} ({window}): "
                f"{count}/{limit} requests"
            )
        
        except RateLimitExceededError:
            # Re-raise rate limit errors
            raise
        except Exception as e:
            # Log error but don't fail the request
            # Fail-open for rate limiting to avoid blocking legitimate requests
            logger.error(
                f"Failed to check rate limit for principal {principal_id}: {e}",
                exc_info=True
            )
    
    def record_request(self, principal_id: UUID) -> None:
        """
        Record a mandate issuance request for rate limiting.
        
        Adds current timestamp to sorted sets for both hourly and
        per-minute windows.
        
        Args:
            principal_id: Principal identifier
        
        Requirements: 14.9
        """
        try:
            current_time = datetime.utcnow()
            current_timestamp = current_time.timestamp()
            
            # Record in hourly window
            hourly_key = self._get_rate_limit_key(principal_id, "hour")
            self.redis.zadd(
                hourly_key,
                {str(current_timestamp): current_timestamp}
            )
            self.redis.expire(hourly_key, 3600)  # Expire after 1 hour
            
            # Record in per-minute window
            minute_key = self._get_rate_limit_key(principal_id, "minute")
            self.redis.zadd(
                minute_key,
                {str(current_timestamp): current_timestamp}
            )
            self.redis.expire(minute_key, 60)  # Expire after 1 minute
            
            logger.debug(f"Recorded mandate issuance request for principal {principal_id}")
        
        except Exception as e:
            # Log error but don't fail the request
            logger.error(
                f"Failed to record rate limit for principal {principal_id}: {e}",
                exc_info=True
            )
    
    def get_current_usage(self, principal_id: UUID) -> dict:
        """
        Get current rate limit usage for a principal.
        
        Args:
            principal_id: Principal identifier
        
        Returns:
            Dictionary with usage statistics:
            - hourly_count: Requests in last hour
            - hourly_limit: Hourly limit
            - hourly_remaining: Remaining requests in hour
            - minute_count: Requests in last minute
            - minute_limit: Per-minute limit
            - minute_remaining: Remaining requests in minute
        """
        try:
            current_time = datetime.utcnow()
            current_timestamp = current_time.timestamp()
            
            # Get hourly usage
            hourly_key = self._get_rate_limit_key(principal_id, "hour")
            min_hourly_timestamp = current_timestamp - 3600
            self.redis.zremrangebyscore(hourly_key, 0, min_hourly_timestamp)
            hourly_count = self.redis._client.zcard(hourly_key)
            
            # Get per-minute usage
            minute_key = self._get_rate_limit_key(principal_id, "minute")
            min_minute_timestamp = current_timestamp - 60
            self.redis.zremrangebyscore(minute_key, 0, min_minute_timestamp)
            minute_count = self.redis._client.zcard(minute_key)
            
            return {
                "hourly_count": hourly_count,
                "hourly_limit": self.limit_per_hour,
                "hourly_remaining": max(0, self.limit_per_hour - hourly_count),
                "minute_count": minute_count,
                "minute_limit": self.limit_per_minute,
                "minute_remaining": max(0, self.limit_per_minute - minute_count)
            }
        
        except Exception as e:
            logger.error(
                f"Failed to get rate limit usage for principal {principal_id}: {e}",
                exc_info=True
            )
            return {
                "hourly_count": 0,
                "hourly_limit": self.limit_per_hour,
                "hourly_remaining": self.limit_per_hour,
                "minute_count": 0,
                "minute_limit": self.limit_per_minute,
                "minute_remaining": self.limit_per_minute
            }
    
    def reset_principal_limits(self, principal_id: UUID) -> None:
        """
        Reset rate limits for a principal.
        
        Use cases:
        - Administrative override
        - Testing
        - Emergency situations
        
        Args:
            principal_id: Principal identifier
        """
        try:
            hourly_key = self._get_rate_limit_key(principal_id, "hour")
            minute_key = self._get_rate_limit_key(principal_id, "minute")
            
            self.redis.delete(hourly_key, minute_key)
            
            logger.info(f"Reset rate limits for principal {principal_id}")
        
        except Exception as e:
            logger.error(
                f"Failed to reset rate limits for principal {principal_id}: {e}",
                exc_info=True
            )
