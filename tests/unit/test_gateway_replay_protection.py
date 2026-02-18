"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for gateway replay protection.

Tests replay protection mechanisms:
- Nonce cache with TTL
- Timestamp validation with 5-minute window
"""

import time
import pytest

from caracal.gateway.replay_protection import (
    ReplayProtection,
    ReplayProtectionConfig,
    ReplayCheckResult,
)


class TestReplayProtectionConfig:
    """Test ReplayProtectionConfig dataclass."""
    
    def test_default_config(self):
        """Test default configuration values."""
        config = ReplayProtectionConfig()
        
        assert config.nonce_cache_ttl == 300  # 5 minutes
        assert config.nonce_cache_size == 100000
        assert config.timestamp_window_seconds == 300  # 5 minutes
        assert config.enable_nonce_validation is True
        assert config.enable_timestamp_validation is True
    
    def test_custom_config(self):
        """Test custom configuration values."""
        config = ReplayProtectionConfig(
            nonce_cache_ttl=600,
            nonce_cache_size=50000,
            timestamp_window_seconds=180,
            enable_nonce_validation=False,
            enable_timestamp_validation=True
        )
        
        assert config.nonce_cache_ttl == 600
        assert config.nonce_cache_size == 50000
        assert config.timestamp_window_seconds == 180
        assert config.enable_nonce_validation is False
        assert config.enable_timestamp_validation is True


class TestReplayProtection:
    """Test ReplayProtection class."""
    
    def test_initialization(self):
        """Test initializing ReplayProtection."""
        rp = ReplayProtection()
        
        assert rp.config.nonce_cache_ttl == 300
        assert rp.config.nonce_cache_size == 100000
        assert rp._nonce_checks == 0
        assert rp._nonce_replays_blocked == 0
    
    def test_initialization_with_custom_config(self):
        """Test initializing with custom config."""
        config = ReplayProtectionConfig(
            nonce_cache_ttl=600,
            nonce_cache_size=50000
        )
        
        rp = ReplayProtection(config=config)
        
        assert rp.config.nonce_cache_ttl == 600
        assert rp.config.nonce_cache_size == 50000
    
    @pytest.mark.asyncio
    async def test_check_nonce_first_use(self):
        """Test nonce validation on first use."""
        rp = ReplayProtection()
        
        result = await rp.check_nonce("test-nonce-12345")
        
        assert result.allowed is True
        assert result.nonce_validated is True
        assert result.timestamp_validated is False
        assert result.reason is None
    
    @pytest.mark.asyncio
    async def test_check_nonce_replay_detected(self):
        """Test nonce validation detects replay."""
        rp = ReplayProtection()
        
        # First use - should succeed
        result1 = await rp.check_nonce("test-nonce-12345")
        assert result1.allowed is True
        
        # Second use - should be blocked as replay
        result2 = await rp.check_nonce("test-nonce-12345")
        assert result2.allowed is False
        assert result2.nonce_validated is True
        assert "Nonce already used" in result2.reason
    
    @pytest.mark.asyncio
    async def test_check_nonce_different_nonces(self):
        """Test that different nonces are allowed."""
        rp = ReplayProtection()
        
        result1 = await rp.check_nonce("nonce-1")
        result2 = await rp.check_nonce("nonce-2")
        result3 = await rp.check_nonce("nonce-3")
        
        assert result1.allowed is True
        assert result2.allowed is True
        assert result3.allowed is True
    
    @pytest.mark.asyncio
    async def test_check_nonce_disabled(self):
        """Test nonce validation when disabled."""
        config = ReplayProtectionConfig(enable_nonce_validation=False)
        rp = ReplayProtection(config=config)
        
        result = await rp.check_nonce("test-nonce")
        
        assert result.allowed is True
        assert result.nonce_validated is False
    
    @pytest.mark.asyncio
    async def test_check_timestamp_valid(self):
        """Test timestamp validation with valid timestamp."""
        rp = ReplayProtection()
        
        current_time = int(time.time())
        result = await rp.check_timestamp(current_time)
        
        assert result.allowed is True
        assert result.timestamp_validated is True
        assert result.nonce_validated is False
        assert result.reason is None
    
    @pytest.mark.asyncio
    async def test_check_timestamp_too_old(self):
        """Test timestamp validation rejects old timestamps."""
        rp = ReplayProtection()
        
        # Timestamp from 10 minutes ago (exceeds 5-minute window)
        old_timestamp = int(time.time()) - 600
        result = await rp.check_timestamp(old_timestamp)
        
        assert result.allowed is False
        assert result.timestamp_validated is True
        assert "Timestamp too old" in result.reason
    
    @pytest.mark.asyncio
    async def test_check_timestamp_in_future(self):
        """Test timestamp validation rejects future timestamps."""
        rp = ReplayProtection()
        
        # Timestamp 2 minutes in future (exceeds 60-second tolerance)
        future_timestamp = int(time.time()) + 120
        result = await rp.check_timestamp(future_timestamp)
        
        assert result.allowed is False
        assert result.timestamp_validated is True
        assert "Timestamp in future" in result.reason
    
    @pytest.mark.asyncio
    async def test_check_timestamp_within_window(self):
        """Test timestamp validation allows timestamps within window."""
        rp = ReplayProtection()
        
        # Timestamp 2 minutes ago (within 5-minute window)
        recent_timestamp = int(time.time()) - 120
        result = await rp.check_timestamp(recent_timestamp)
        
        assert result.allowed is True
        assert result.timestamp_validated is True
    
    @pytest.mark.asyncio
    async def test_check_timestamp_disabled(self):
        """Test timestamp validation when disabled."""
        config = ReplayProtectionConfig(enable_timestamp_validation=False)
        rp = ReplayProtection(config=config)
        
        old_timestamp = int(time.time()) - 600
        result = await rp.check_timestamp(old_timestamp)
        
        assert result.allowed is True
        assert result.timestamp_validated is False
    
    @pytest.mark.asyncio
    async def test_check_request_with_nonce_only(self):
        """Test complete request check with nonce only."""
        rp = ReplayProtection()
        
        result = await rp.check_request(nonce="test-nonce")
        
        assert result.allowed is True
        assert result.nonce_validated is True
        assert result.timestamp_validated is False
    
    @pytest.mark.asyncio
    async def test_check_request_with_timestamp_only(self):
        """Test complete request check with timestamp only."""
        rp = ReplayProtection()
        
        current_time = int(time.time())
        result = await rp.check_request(timestamp=current_time)
        
        assert result.allowed is True
        assert result.nonce_validated is False
        assert result.timestamp_validated is True
    
    @pytest.mark.asyncio
    async def test_check_request_with_both(self):
        """Test complete request check with both nonce and timestamp."""
        rp = ReplayProtection()
        
        current_time = int(time.time())
        result = await rp.check_request(
            nonce="test-nonce",
            timestamp=current_time
        )
        
        assert result.allowed is True
        assert result.nonce_validated is True
        assert result.timestamp_validated is True
    
    @pytest.mark.asyncio
    async def test_check_request_nonce_replay(self):
        """Test complete request check detects nonce replay."""
        rp = ReplayProtection()
        
        # First request
        result1 = await rp.check_request(nonce="test-nonce")
        assert result1.allowed is True
        
        # Replay attempt
        result2 = await rp.check_request(nonce="test-nonce")
        assert result2.allowed is False
        assert "Nonce already used" in result2.reason
    
    @pytest.mark.asyncio
    async def test_check_request_timestamp_too_old(self):
        """Test complete request check detects old timestamp."""
        rp = ReplayProtection()
        
        old_timestamp = int(time.time()) - 600
        result = await rp.check_request(timestamp=old_timestamp)
        
        assert result.allowed is False
        assert "Timestamp too old" in result.reason
    
    @pytest.mark.asyncio
    async def test_check_request_no_protection(self):
        """Test complete request check with no nonce or timestamp."""
        rp = ReplayProtection()
        
        result = await rp.check_request()
        
        # Should allow but log warning
        assert result.allowed is True
        assert result.nonce_validated is False
        assert result.timestamp_validated is False
    
    def test_get_stats(self):
        """Test getting replay protection statistics."""
        rp = ReplayProtection()
        
        stats = rp.get_stats()
        
        assert stats["nonce_checks"] == 0
        assert stats["nonce_replays_blocked"] == 0
        assert stats["timestamp_checks"] == 0
        assert stats["timestamp_replays_blocked"] == 0
        assert stats["nonce_cache_size"] == 0
        assert stats["nonce_cache_max_size"] == 100000
    
    @pytest.mark.asyncio
    async def test_get_stats_after_operations(self):
        """Test statistics after performing operations."""
        rp = ReplayProtection()
        
        # Perform some operations
        await rp.check_nonce("nonce-1")
        await rp.check_nonce("nonce-1")  # Replay
        await rp.check_timestamp(int(time.time()))
        await rp.check_timestamp(int(time.time()) - 600)  # Too old
        
        stats = rp.get_stats()
        
        assert stats["nonce_checks"] == 2
        assert stats["nonce_replays_blocked"] == 1
        assert stats["timestamp_checks"] == 2
        assert stats["timestamp_replays_blocked"] == 1
        assert stats["nonce_cache_size"] == 1  # Only one unique nonce
    
    def test_clear_cache(self):
        """Test clearing the nonce cache."""
        rp = ReplayProtection()
        
        # Add some nonces
        import asyncio
        asyncio.run(rp.check_nonce("nonce-1"))
        asyncio.run(rp.check_nonce("nonce-2"))
        
        stats_before = rp.get_stats()
        assert stats_before["nonce_cache_size"] == 2
        
        # Clear cache
        rp.clear_cache()
        
        stats_after = rp.get_stats()
        assert stats_after["nonce_cache_size"] == 0
    
    @pytest.mark.asyncio
    async def test_nonce_cache_ttl_expiration(self):
        """Test that nonces expire after TTL."""
        # Use short TTL for testing
        config = ReplayProtectionConfig(nonce_cache_ttl=1)  # 1 second
        rp = ReplayProtection(config=config)
        
        # Add nonce
        result1 = await rp.check_nonce("test-nonce")
        assert result1.allowed is True
        
        # Immediately try again - should be blocked
        result2 = await rp.check_nonce("test-nonce")
        assert result2.allowed is False
        
        # Wait for TTL to expire
        time.sleep(1.5)
        
        # Try again - should be allowed (nonce expired from cache)
        result3 = await rp.check_nonce("test-nonce")
        assert result3.allowed is True
    
    @pytest.mark.asyncio
    async def test_custom_timestamp_window(self):
        """Test custom timestamp window configuration."""
        # Use 10-minute window instead of default 5 minutes
        config = ReplayProtectionConfig(timestamp_window_seconds=600)
        rp = ReplayProtection(config=config)
        
        # Timestamp 8 minutes ago (would fail with 5-minute window)
        timestamp = int(time.time()) - 480
        result = await rp.check_timestamp(timestamp)
        
        assert result.allowed is True
        assert result.timestamp_validated is True
