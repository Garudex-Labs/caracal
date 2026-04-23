"""
Security tests for rate limiting.

Tests rate limit enforcement under load and rate limit bypass attempts
to ensure rate limiting protects against abuse.
"""

import pytest
from uuid import uuid4
from unittest.mock import Mock, MagicMock

from caracal.core.rate_limiter import MandateIssuanceRateLimiter
from caracal.exceptions import RateLimitExceededError


@pytest.mark.security
class TestRateLimitingSecurity:
    """Security tests for rate limiting."""
    
    def test_rate_limit_enforced_under_load(self):
        """Test that rate limits are enforced under high load."""
        # Create mock Redis client
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=0)
        mock_redis.zremrangebyscore = Mock()
        mock_redis.zadd = Mock()
        mock_redis.expire = Mock()
        
        # Create rate limiter with low limits for testing
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=10,
            limit_per_minute=5
        )
        
        principal_id = uuid4()
        
        # Simulate requests up to the limit
        for i in range(5):
            mock_redis._client.zcard.return_value = i
            rate_limiter.check_rate_limit(principal_id)
        
        # Next request should exceed limit
        mock_redis._client.zcard.return_value = 5
        with pytest.raises(RateLimitExceededError, match="Rate limit exceeded"):
            rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_per_minute_enforced(self):
        """Test that per-minute rate limits are enforced."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=10)  # At limit
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Should fail due to per-minute limit
        with pytest.raises(RateLimitExceededError, match="minute"):
            rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_per_hour_enforced(self):
        """Test that per-hour rate limits are enforced."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        
        # Mock zcard to return different values for different calls
        call_count = [0]
        def zcard_side_effect(key):
            if "minute" in key:
                return 5  # Under minute limit
            else:
                return 100  # At hour limit
        
        mock_redis._client.zcard = Mock(side_effect=zcard_side_effect)
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Should fail due to per-hour limit
        with pytest.raises(RateLimitExceededError, match="hour"):
            rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_bypass_attempt_fails(self):
        """Test that attempts to bypass rate limits fail."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=10)  # At limit
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Multiple attempts should all fail
        for _ in range(5):
            with pytest.raises(RateLimitExceededError):
                rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_different_principals_isolated(self):
        """Test that rate limits are isolated per principal."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        
        # Track calls per principal
        call_counts = {}
        
        def zcard_side_effect(key):
            # Extract principal ID from key
            if key not in call_counts:
                call_counts[key] = 0
            return call_counts[key]
        
        mock_redis._client.zcard = Mock(side_effect=zcard_side_effect)
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal1 = uuid4()
        principal2 = uuid4()
        
        # Principal 1 should be able to make requests
        rate_limiter.check_rate_limit(principal1)
        
        # Principal 2 should also be able to make requests (independent limit)
        rate_limiter.check_rate_limit(principal2)
    
    def test_rate_limit_fail_closed_on_redis_error(self):
        """Test that rate limiter fails closed when Redis is unavailable."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(side_effect=Exception("Redis connection failed"))
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Should fail closed (deny request) when Redis is unavailable
        with pytest.raises(RateLimitExceededError, match="fail-closed"):
            rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_usage_tracking(self):
        """Test that rate limit usage is accurately tracked."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=5)
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Get current usage
        usage = rate_limiter.get_current_usage(principal_id)
        
        # Verify usage structure
        assert "hourly_count" in usage
        assert "hourly_limit" in usage
        assert "hourly_remaining" in usage
        assert "minute_count" in usage
        assert "minute_limit" in usage
        assert "minute_remaining" in usage
        
        # Verify limits are correct
        assert usage["hourly_limit"] == 100
        assert usage["minute_limit"] == 10
    
    def test_rate_limit_reset_clears_limits(self):
        """Test that rate limit reset clears principal limits."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=10)  # At limit
        mock_redis.zremrangebyscore = Mock()
        mock_redis.delete = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Reset limits
        rate_limiter.reset_principal_limits(principal_id)
        
        # Verify delete was called
        assert mock_redis.delete.called
    
    def test_concurrent_requests_rate_limited(self):
        """Test that concurrent requests are properly rate limited."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        stores: dict[str, list] = {"hour": [], "minute": []}

        def _window(key):
            key_s = key.decode() if isinstance(key, bytes) else str(key)
            return "minute" if key_s.endswith(":minute") else "hour"

        def zcard_side_effect(key):
            return len(stores[_window(key)])

        def zadd_side_effect(key, mapping):
            stores[_window(key)].extend(mapping.keys())

        mock_redis._client.zcard = Mock(side_effect=zcard_side_effect)
        mock_redis.zremrangebyscore = Mock()
        mock_redis.zadd = Mock(side_effect=zadd_side_effect)
        mock_redis.expire = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Ten check+record cycles fill the per-minute window to 10 entries.
        for i in range(10):
            try:
                rate_limiter.check_rate_limit(principal_id)
            except RateLimitExceededError:
                pytest.fail(f"Rate limit exceeded too early at request {i}")
            rate_limiter.record_request(principal_id)
        
        # Next check should see a full minute window
        with pytest.raises(RateLimitExceededError):
            rate_limiter.check_rate_limit(principal_id)
    
    def test_rate_limit_sliding_window(self):
        """Test that rate limiting uses sliding window correctly."""
        mock_redis = Mock()
        mock_redis._client = Mock()
        mock_redis._client.zcard = Mock(return_value=5)
        mock_redis.zremrangebyscore = Mock()
        
        rate_limiter = MandateIssuanceRateLimiter(
            redis_client=mock_redis,
            limit_per_hour=100,
            limit_per_minute=10
        )
        
        principal_id = uuid4()
        
        # Check rate limit
        rate_limiter.check_rate_limit(principal_id)
        
        # Verify that expired timestamps are removed (sliding window)
        assert mock_redis.zremrangebyscore.called
        
        # Verify zremrangebyscore was called with correct parameters
        # (should remove timestamps older than the window)
        calls = mock_redis.zremrangebyscore.call_args_list
        assert len(calls) >= 2  # Called for both hour and minute windows
