"""
Unit tests for Rate Limiter functionality.

This module tests the MandateIssuanceRateLimiter class.
"""
import pytest
from datetime import datetime
from uuid import uuid4
from unittest.mock import Mock, MagicMock, patch

from caracal.core.rate_limiter import MandateIssuanceRateLimiter
from caracal.exceptions import RateLimitExceededError


@pytest.mark.unit
class TestMandateIssuanceRateLimiter:
    """Test suite for MandateIssuanceRateLimiter class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_redis = Mock()
        self.mock_redis._client = Mock()
        self.limiter = MandateIssuanceRateLimiter(
            redis_client=self.mock_redis,
            limit_per_hour=10,
            limit_per_minute=5
        )
    
    def test_rate_limiter_initialization(self):
        """Test rate limiter initialization with custom limits."""
        # Assert
        assert self.limiter.limit_per_hour == 10
        assert self.limiter.limit_per_minute == 5
    
    def test_rate_limiter_default_limits(self):
        """Test rate limiter initialization with default limits."""
        # Act
        limiter = MandateIssuanceRateLimiter(redis_client=self.mock_redis)
        
        # Assert
        assert limiter.limit_per_hour == 100
        assert limiter.limit_per_minute == 10
    
    def test_get_rate_limit_key_format(self):
        """Test rate limit key format."""
        # Arrange
        principal_id = uuid4()
        
        # Act
        hourly_key = self.limiter._get_rate_limit_key(principal_id, "hour")
        minute_key = self.limiter._get_rate_limit_key(principal_id, "minute")
        
        # Assert
        assert f"caracal:rate_limit:mandate_issuance:{principal_id}:hour" == hourly_key
        assert f"caracal:rate_limit:mandate_issuance:{principal_id}:minute" == minute_key
    
    def test_check_rate_limit_within_limits(self):
        """Test rate limit check when within limits."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock()
        self.mock_redis._client.zcard = Mock(return_value=3)  # Below limits
        
        # Act - Should not raise
        self.limiter.check_rate_limit(principal_id)
        
        # Assert
        assert self.mock_redis.zremrangebyscore.call_count == 2  # hourly + minute
    
    def test_check_rate_limit_hourly_exceeded(self):
        """Test rate limit check when hourly limit exceeded."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock()
        self.mock_redis._client.zcard = Mock(return_value=11)  # Above hourly limit
        
        # Act & Assert
        with pytest.raises(RateLimitExceededError) as exc_info:
            self.limiter.check_rate_limit(principal_id)
        
        assert "hour" in str(exc_info.value).lower()
    
    def test_check_rate_limit_minute_exceeded(self):
        """Test rate limit check when per-minute limit exceeded."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock()
        
        # First call (hourly) returns 3, second call (minute) returns 6
        self.mock_redis._client.zcard = Mock(side_effect=[3, 6])
        
        # Act & Assert
        with pytest.raises(RateLimitExceededError) as exc_info:
            self.limiter.check_rate_limit(principal_id)
        
        assert "minute" in str(exc_info.value).lower()
    
    def test_check_rate_limit_redis_failure(self):
        """Test rate limit check fails closed on Redis error."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock(side_effect=Exception("Redis error"))
        
        # Act & Assert
        with pytest.raises(RateLimitExceededError) as exc_info:
            self.limiter.check_rate_limit(principal_id)
        
        assert "fail-closed" in str(exc_info.value).lower()
    
    def test_record_request(self):
        """Test recording a mandate issuance request."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zadd = Mock()
        self.mock_redis.expire = Mock()
        
        # Act
        self.limiter.record_request(principal_id)
        
        # Assert
        assert self.mock_redis.zadd.call_count == 2  # hourly + minute
        assert self.mock_redis.expire.call_count == 2
    
    def test_record_request_handles_errors(self):
        """Test recording request handles Redis errors gracefully."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zadd = Mock(side_effect=Exception("Redis error"))
        
        # Act - Should not raise
        self.limiter.record_request(principal_id)
    
    def test_get_current_usage(self):
        """Test getting current rate limit usage."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock()
        self.mock_redis._client.zcard = Mock(side_effect=[7, 3])  # hourly, minute
        
        # Act
        usage = self.limiter.get_current_usage(principal_id)
        
        # Assert
        assert usage["hourly_count"] == 7
        assert usage["hourly_limit"] == 10
        assert usage["hourly_remaining"] == 3
        assert usage["minute_count"] == 3
        assert usage["minute_limit"] == 5
        assert usage["minute_remaining"] == 2
    
    def test_get_current_usage_handles_errors(self):
        """Test getting usage handles Redis errors gracefully."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock(side_effect=Exception("Redis error"))
        
        # Act
        usage = self.limiter.get_current_usage(principal_id)
        
        # Assert - Returns default values
        assert usage["hourly_count"] == 0
        assert usage["hourly_remaining"] == 10
        assert usage["minute_count"] == 0
        assert usage["minute_remaining"] == 5
    
    def test_reset_principal_limits(self):
        """Test resetting rate limits for a principal."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.delete = Mock()
        
        # Act
        self.limiter.reset_principal_limits(principal_id)
        
        # Assert
        self.mock_redis.delete.assert_called_once()
    
    def test_reset_principal_limits_handles_errors(self):
        """Test resetting limits handles Redis errors gracefully."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.delete = Mock(side_effect=Exception("Redis error"))
        
        # Act - Should not raise
        self.limiter.reset_principal_limits(principal_id)


@pytest.mark.unit
class TestRateLimiterWindowHandling:
    """Test suite for rate limiter window handling."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_redis = Mock()
        self.mock_redis._client = Mock()
        self.limiter = MandateIssuanceRateLimiter(
            redis_client=self.mock_redis,
            limit_per_hour=10,
            limit_per_minute=5
        )
    
    def test_window_cleanup_removes_old_entries(self):
        """Test that old entries are removed from window."""
        # Arrange
        principal_id = uuid4()
        self.mock_redis.zremrangebyscore = Mock()
        self.mock_redis._client.zcard = Mock(return_value=0)
        
        # Act
        self.limiter.check_rate_limit(principal_id)
        
        # Assert - zremrangebyscore called to clean up old entries
        assert self.mock_redis.zremrangebyscore.call_count == 2
    
    def test_rate_limit_reset_after_window(self):
        """Test rate limit effectively resets after window expires."""
        # Arrange
        principal_id = uuid4()
        
        # First check - at limit
        self.mock_redis.zremrangebyscore = Mock()
        self.mock_redis._client.zcard = Mock(return_value=10)
        
        with pytest.raises(RateLimitExceededError):
            self.limiter.check_rate_limit(principal_id)
        
        # Second check - after cleanup, below limit
        self.mock_redis._client.zcard = Mock(return_value=3)
        
        # Act - Should not raise
        self.limiter.check_rate_limit(principal_id)
        
        # Assert - Passed without error
        assert True
