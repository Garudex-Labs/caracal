"""
Unit tests for Circuit Breaker functionality.

This module tests the CircuitBreaker class and its state transitions.
"""
import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, patch

from caracal.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerError,
    CircuitBreakerRegistry,
    get_circuit_breaker_registry
)
from caracal.monitoring.metrics import CircuitBreakerState


@pytest.mark.unit
class TestCircuitBreakerConfig:
    """Test suite for CircuitBreakerConfig dataclass."""
    
    def test_config_default_values(self):
        """Test circuit breaker config with default values."""
        # Act
        config = CircuitBreakerConfig()
        
        # Assert
        assert config.failure_threshold == 5
        assert config.success_threshold == 2
        assert config.timeout_seconds == 60.0
        assert config.half_open_max_calls == 1
    
    def test_config_custom_values(self):
        """Test circuit breaker config with custom values."""
        # Act
        config = CircuitBreakerConfig(
            failure_threshold=10,
            success_threshold=3,
            timeout_seconds=120.0,
            half_open_max_calls=2
        )
        
        # Assert
        assert config.failure_threshold == 10
        assert config.success_threshold == 3
        assert config.timeout_seconds == 120.0
        assert config.half_open_max_calls == 2


@pytest.mark.unit
class TestCircuitBreaker:
    """Test suite for CircuitBreaker class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.config = CircuitBreakerConfig(
            failure_threshold=3,
            success_threshold=2,
            timeout_seconds=1.0
        )
        self.breaker = CircuitBreaker("test-service", self.config)
    
    def test_circuit_breaker_initial_state(self):
        """Test circuit breaker starts in closed state."""
        # Assert
        assert self.breaker.state == CircuitBreakerState.CLOSED
        assert self.breaker.is_closed is True
        assert self.breaker.is_open is False
        assert self.breaker.is_half_open is False
    
    @pytest.mark.asyncio
    async def test_successful_call_in_closed_state(self):
        """Test successful call in closed state."""
        # Arrange
        async def successful_operation():
            return "success"
        
        # Act
        result = await self.breaker.call(successful_operation)
        
        # Assert
        assert result == "success"
        assert self.breaker.state == CircuitBreakerState.CLOSED
    
    @pytest.mark.asyncio
    async def test_failed_call_increments_failure_count(self):
        """Test failed call increments failure count."""
        # Arrange
        async def failing_operation():
            raise ValueError("Test error")
        
        # Act & Assert
        with pytest.raises(ValueError):
            await self.breaker.call(failing_operation)
        
        assert self.breaker._failure_count == 1
        assert self.breaker.state == CircuitBreakerState.CLOSED
    
    @pytest.mark.asyncio
    async def test_circuit_opens_after_threshold_failures(self):
        """Test circuit breaker opens after reaching failure threshold."""
        # Arrange
        async def failing_operation():
            raise ValueError("Test error")
        
        # Act - Fail 3 times (threshold)
        for _ in range(3):
            with pytest.raises(ValueError):
                await self.breaker.call(failing_operation)
        
        # Assert
        assert self.breaker.state == CircuitBreakerState.OPEN
        assert self.breaker.is_open is True
    
    @pytest.mark.asyncio
    async def test_open_circuit_rejects_calls(self):
        """Test open circuit breaker rejects calls immediately."""
        # Arrange - Open the circuit
        async def failing_operation():
            raise ValueError("Test error")
        
        for _ in range(3):
            with pytest.raises(ValueError):
                await self.breaker.call(failing_operation)
        
        # Act & Assert - Try to call when open
        async def any_operation():
            return "should not execute"
        
        with pytest.raises(CircuitBreakerError) as exc_info:
            await self.breaker.call(any_operation)
        
        assert "open" in str(exc_info.value).lower()
    
    @pytest.mark.asyncio
    async def test_circuit_transitions_to_half_open_after_timeout(self):
        """Test circuit breaker transitions to half-open after timeout."""
        # Arrange - Open the circuit
        async def failing_operation():
            raise ValueError("Test error")
        
        for _ in range(3):
            with pytest.raises(ValueError):
                await self.breaker.call(failing_operation)
        
        assert self.breaker.state == CircuitBreakerState.OPEN
        
        # Act - Wait for timeout
        await asyncio.sleep(1.1)  # Slightly longer than timeout
        
        # Try a call to trigger state check
        async def test_operation():
            return "test"
        
        result = await self.breaker.call(test_operation)
        
        # Assert
        assert result == "test"
        assert self.breaker.state == CircuitBreakerState.HALF_OPEN
    
    @pytest.mark.asyncio
    async def test_half_open_success_closes_circuit(self):
        """Test successful calls in half-open state close the circuit."""
        # Arrange - Get to half-open state
        self.breaker._state = CircuitBreakerState.HALF_OPEN
        
        async def successful_operation():
            return "success"
        
        # Act - Succeed twice (threshold)
        for _ in range(2):
            await self.breaker.call(successful_operation)
        
        # Assert
        assert self.breaker.state == CircuitBreakerState.CLOSED
    
    @pytest.mark.asyncio
    async def test_half_open_failure_reopens_circuit(self):
        """Test failure in half-open state reopens the circuit."""
        # Arrange - Get to half-open state
        self.breaker._state = CircuitBreakerState.HALF_OPEN
        
        async def failing_operation():
            raise ValueError("Test error")
        
        # Act & Assert
        with pytest.raises(ValueError):
            await self.breaker.call(failing_operation)
        
        assert self.breaker.state == CircuitBreakerState.OPEN
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_with_sync_function(self):
        """Test circuit breaker works with synchronous functions."""
        # Arrange
        def sync_operation():
            return "sync result"
        
        # Act
        result = await self.breaker.call(sync_operation)
        
        # Assert
        assert result == "sync result"
    
    @pytest.mark.asyncio
    async def test_circuit_breaker_decorator(self):
        """Test circuit breaker as decorator."""
        # Arrange
        @self.breaker
        async def decorated_operation():
            return "decorated result"
        
        # Act
        result = await decorated_operation()
        
        # Assert
        assert result == "decorated result"


@pytest.mark.unit
class TestCircuitBreakerRegistry:
    """Test suite for CircuitBreakerRegistry class."""
    
    @pytest.mark.asyncio
    async def test_registry_get_or_create_new(self):
        """Test registry creates new circuit breaker."""
        # Arrange
        registry = CircuitBreakerRegistry()
        
        # Act
        breaker = await registry.get_or_create("test-service")
        
        # Assert
        assert breaker is not None
        assert breaker.name == "test-service"
    
    @pytest.mark.asyncio
    async def test_registry_get_or_create_existing(self):
        """Test registry returns existing circuit breaker."""
        # Arrange
        registry = CircuitBreakerRegistry()
        breaker1 = await registry.get_or_create("test-service")
        
        # Act
        breaker2 = await registry.get_or_create("test-service")
        
        # Assert
        assert breaker1 is breaker2
    
    def test_registry_get_nonexistent(self):
        """Test registry returns None for nonexistent breaker."""
        # Arrange
        registry = CircuitBreakerRegistry()
        
        # Act
        breaker = registry.get("nonexistent")
        
        # Assert
        assert breaker is None
    
    @pytest.mark.asyncio
    async def test_registry_get_all(self):
        """Test registry returns all circuit breakers."""
        # Arrange
        registry = CircuitBreakerRegistry()
        await registry.get_or_create("service1")
        await registry.get_or_create("service2")
        
        # Act
        all_breakers = registry.get_all()
        
        # Assert
        assert len(all_breakers) == 2
        assert "service1" in all_breakers
        assert "service2" in all_breakers
    
    @pytest.mark.asyncio
    async def test_registry_reset_breaker(self):
        """Test registry can reset a circuit breaker."""
        # Arrange
        registry = CircuitBreakerRegistry()
        breaker = await registry.get_or_create("test-service")
        breaker._state = CircuitBreakerState.OPEN
        
        # Act
        await registry.reset("test-service")
        
        # Assert
        assert breaker.state == CircuitBreakerState.CLOSED
    
    @pytest.mark.asyncio
    async def test_registry_reset_all(self):
        """Test registry can reset all circuit breakers."""
        # Arrange
        registry = CircuitBreakerRegistry()
        breaker1 = await registry.get_or_create("service1")
        breaker2 = await registry.get_or_create("service2")
        breaker1._state = CircuitBreakerState.OPEN
        breaker2._state = CircuitBreakerState.OPEN
        
        # Act
        await registry.reset_all()
        
        # Assert
        assert breaker1.state == CircuitBreakerState.CLOSED
        assert breaker2.state == CircuitBreakerState.CLOSED


@pytest.mark.unit
class TestCircuitBreakerGlobalRegistry:
    """Test suite for global circuit breaker registry."""
    
    def test_get_global_registry(self):
        """Test getting global circuit breaker registry."""
        # Act
        registry1 = get_circuit_breaker_registry()
        registry2 = get_circuit_breaker_registry()
        
        # Assert
        assert registry1 is registry2  # Singleton
