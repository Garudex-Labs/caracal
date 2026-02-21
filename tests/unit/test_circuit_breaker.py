"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for circuit breaker functionality.

Tests circuit breaker state transitions, failure handling, and recovery.

"""

import asyncio
import pytest
from unittest.mock import Mock, patch

from caracal.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerError,
    CircuitBreakerRegistry,
    get_circuit_breaker_registry,
    get_circuit_breaker,
)
from caracal.monitoring.metrics import CircuitBreakerState


class TestCircuitBreaker:
    """Test circuit breaker functionality."""
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_starts_closed(self):
        """Test that circuit breaker starts in CLOSED state."""
        breaker = CircuitBreaker("test")
        
        assert breaker.state == CircuitBreakerState.CLOSED
        assert breaker.is_closed
        assert not breaker.is_open
        assert not breaker.is_half_open
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_allows_calls_when_closed(self):
        """Test that circuit breaker allows calls in CLOSED state."""
        breaker = CircuitBreaker("test")
        
        async def successful_call():
            return "success"
        
        result = await breaker.call(successful_call)
        assert result == "success"
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_opens_after_threshold_failures(self):
        """Test that circuit breaker opens after failure threshold is reached."""
        config = CircuitBreakerConfig(failure_threshold=3)
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        # First 2 failures should not open circuit
        for i in range(2):
            with pytest.raises(Exception, match="Service unavailable"):
                await breaker.call(failing_call)
            assert breaker.is_closed
        
        # Third failure should open circuit
        with pytest.raises(Exception, match="Service unavailable"):
            await breaker.call(failing_call)
        
        assert breaker.is_open
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_fails_fast_when_open(self):
        """Test that circuit breaker fails fast when OPEN."""
        config = CircuitBreakerConfig(failure_threshold=1)
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        # Open the circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Subsequent calls should fail immediately with CircuitBreakerError
        with pytest.raises(CircuitBreakerError, match="Circuit breaker 'test' is open"):
            await breaker.call(failing_call)
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_transitions_to_half_open_after_timeout(self):
        """Test that circuit breaker transitions to HALF_OPEN after timeout."""
        config = CircuitBreakerConfig(
            failure_threshold=1,
            timeout_seconds=0.1  # Short timeout for testing
        )
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        # Open the circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Wait for timeout
        await asyncio.sleep(0.15)
        
        # Next call should check timeout and transition to half-open
        async def successful_call():
            return "success"
        
        result = await breaker.call(successful_call)
        assert result == "success"
        assert breaker.is_half_open or breaker.is_closed  # May close immediately if success threshold is 1
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_closes_after_success_threshold_in_half_open(self):
        """Test that circuit breaker closes after success threshold in HALF_OPEN state."""
        config = CircuitBreakerConfig(
            failure_threshold=1,
            success_threshold=2,
            timeout_seconds=0.1
        )
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        async def successful_call():
            return "success"
        
        # Open the circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Wait for timeout
        await asyncio.sleep(0.15)
        
        # First successful call in half-open
        result = await breaker.call(successful_call)
        assert result == "success"
        assert breaker.is_half_open
        
        # Second successful call should close circuit
        result = await breaker.call(successful_call)
        assert result == "success"
        assert breaker.is_closed
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_reopens_on_failure_in_half_open(self):
        """Test that circuit breaker reopens on failure in HALF_OPEN state."""
        config = CircuitBreakerConfig(
            failure_threshold=1,
            timeout_seconds=0.1
        )
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        # Open the circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Wait for timeout
        await asyncio.sleep(0.15)
        
        # Failure in half-open should reopen circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_limits_concurrent_calls_in_half_open(self):
        """Test that circuit breaker limits concurrent calls in HALF_OPEN state."""
        config = CircuitBreakerConfig(
            failure_threshold=1,
            timeout_seconds=0.1,
            half_open_max_calls=1
        )
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        async def slow_call():
            await asyncio.sleep(0.2)
            return "success"
        
        # Open the circuit
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Wait for timeout
        await asyncio.sleep(0.15)
        
        # Start first call (should be allowed)
        task1 = asyncio.create_task(breaker.call(slow_call))
        
        # Give it time to start
        await asyncio.sleep(0.05)
        
        # Second concurrent call should fail
        with pytest.raises(CircuitBreakerError, match="half-open with max concurrent calls"):
            await breaker.call(slow_call)
        
        # Wait for first call to complete
        result = await task1
        assert result == "success"
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_resets_failure_count_on_success_in_closed(self):
        """Test that circuit breaker resets failure count on success in CLOSED state."""
        config = CircuitBreakerConfig(failure_threshold=3)
        breaker = CircuitBreaker("test", config)
        
        async def failing_call():
            raise Exception("Service unavailable")
        
        async def successful_call():
            return "success"
        
        # Two failures
        for i in range(2):
            with pytest.raises(Exception):
                await breaker.call(failing_call)
        
        assert breaker.is_closed
        
        # Success should reset failure count
        result = await breaker.call(successful_call)
        assert result == "success"
        
        # Two more failures should not open circuit (count was reset)
        for i in range(2):
            with pytest.raises(Exception):
                await breaker.call(failing_call)
        
        assert breaker.is_closed
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_decorator(self):
        """Test circuit breaker as a decorator."""
        config = CircuitBreakerConfig(failure_threshold=2)
        breaker = CircuitBreaker("test", config)
        
        @breaker
        async def decorated_function(value):
            if value == "fail":
                raise Exception("Failed")
            return value
        
        # Successful call
        result = await decorated_function("success")
        assert result == "success"
        
        # Failures
        with pytest.raises(Exception):
            await decorated_function("fail")
        
        with pytest.raises(Exception):
            await decorated_function("fail")
        
        # Circuit should be open
        assert breaker.is_open
        
        # Next call should fail fast
        with pytest.raises(CircuitBreakerError):
            await decorated_function("success")
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_with_sync_function(self):
        """Test circuit breaker with synchronous function."""
        breaker = CircuitBreaker("test")
        
        def sync_function():
            return "sync_result"
        
        result = await breaker.call(sync_function)
        assert result == "sync_result"


class TestCircuitBreakerRegistry:
    """Test circuit breaker registry functionality."""
    
    @pytest.mark.asyncio
    async def test_registry_creates_new_breaker(self):
        """Test that registry creates new circuit breaker."""
        registry = CircuitBreakerRegistry()
        
        breaker = await registry.get_or_create("test")
        
        assert breaker is not None
        assert breaker.name == "test"
    
    @pytest.mark.asyncio
    async def test_registry_returns_existing_breaker(self):
        """Test that registry returns existing circuit breaker."""
        registry = CircuitBreakerRegistry()
        
        breaker1 = await registry.get_or_create("test")
        breaker2 = await registry.get_or_create("test")
        
        assert breaker1 is breaker2
    
    @pytest.mark.asyncio
    async def test_registry_get_returns_none_for_nonexistent(self):
        """Test that registry get returns None for nonexistent breaker."""
        registry = CircuitBreakerRegistry()
        
        breaker = registry.get("nonexistent")
        
        assert breaker is None
    
    @pytest.mark.asyncio
    async def test_registry_get_all(self):
        """Test that registry returns all circuit breakers."""
        registry = CircuitBreakerRegistry()
        
        await registry.get_or_create("breaker1")
        await registry.get_or_create("breaker2")
        
        all_breakers = registry.get_all()
        
        assert len(all_breakers) == 2
        assert "breaker1" in all_breakers
        assert "breaker2" in all_breakers
    
    @pytest.mark.asyncio
    async def test_registry_reset(self):
        """Test that registry can reset a circuit breaker."""
        registry = CircuitBreakerRegistry()
        config = CircuitBreakerConfig(failure_threshold=1)
        
        breaker = await registry.get_or_create("test", config)
        
        # Open the circuit
        async def failing_call():
            raise Exception("Failed")
        
        with pytest.raises(Exception):
            await breaker.call(failing_call)
        
        assert breaker.is_open
        
        # Reset
        await registry.reset("test")
        
        assert breaker.is_closed
    
    @pytest.mark.asyncio
    async def test_registry_reset_all(self):
        """Test that registry can reset all circuit breakers."""
        registry = CircuitBreakerRegistry()
        config = CircuitBreakerConfig(failure_threshold=1)
        
        breaker1 = await registry.get_or_create("test1", config)
        breaker2 = await registry.get_or_create("test2", config)
        
        # Open both circuits
        async def failing_call():
            raise Exception("Failed")
        
        with pytest.raises(Exception):
            await breaker1.call(failing_call)
        
        with pytest.raises(Exception):
            await breaker2.call(failing_call)
        
        assert breaker1.is_open
        assert breaker2.is_open
        
        # Reset all
        await registry.reset_all()
        
        assert breaker1.is_closed
        assert breaker2.is_closed
    
    @pytest.mark.asyncio
    async def test_global_registry(self):
        """Test global circuit breaker registry."""
        registry1 = get_circuit_breaker_registry()
        registry2 = get_circuit_breaker_registry()
        
        assert registry1 is registry2
    
    @pytest.mark.asyncio
    async def test_get_circuit_breaker_helper(self):
        """Test get_circuit_breaker helper function."""
        breaker = await get_circuit_breaker("test")
        
        assert breaker is not None
        assert breaker.name == "test"
        
        # Should return same instance
        breaker2 = await get_circuit_breaker("test")
        assert breaker is breaker2
