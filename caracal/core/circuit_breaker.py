"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Circuit breaker implementation for Caracal Core.

This module provides circuit breaker functionality to handle failures in external services
(database operations, policy service, MCP servers) with automatic recovery.

Circuit breaker states:
- CLOSED: Normal operation, requests pass through
- OPEN: Too many failures, requests fail immediately
- HALF_OPEN: Testing if service recovered, limited requests pass through
"""

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional, TypeVar, Any, Dict
import functools

from caracal.logging_config import get_logger
from caracal.monitoring.metrics import CircuitBreakerState, get_metrics_registry

logger = get_logger(__name__)

T = TypeVar('T')


class CircuitBreakerError(Exception):
    """Exception raised when circuit breaker is open."""
    pass


@dataclass
class CircuitBreakerConfig:
    """
    Configuration for circuit breaker behavior.
    
    Attributes:
        failure_threshold: Number of failures before opening circuit (default: 5)
        success_threshold: Number of successes in half-open state to close circuit (default: 2)
        timeout_seconds: Time to wait before transitioning from open to half-open (default: 60)
        half_open_max_calls: Maximum concurrent calls allowed in half-open state (default: 1)
    """
    failure_threshold: int = 5
    success_threshold: int = 2
    timeout_seconds: float = 60.0
    half_open_max_calls: int = 1


class CircuitBreaker:
    """
    Circuit breaker for protecting against cascading failures.
    
    The circuit breaker monitors failures and automatically opens when failure
    threshold is exceeded. After a timeout period, it transitions to half-open
    to test if the service has recovered.
    
    States:
    - CLOSED: Normal operation, all requests pass through
    - OPEN: Too many failures, all requests fail immediately
    - HALF_OPEN: Testing recovery, limited requests pass through
    
    Requirements: 23.5, 23.6
    """
    
    def __init__(self, name: str, config: Optional[CircuitBreakerConfig] = None):
        """
        Initialize circuit breaker.
        
        Args:
            name: Name of the circuit breaker (e.g., "database", "policy_service")
            config: Configuration for circuit breaker behavior
        """
        self.name = name
        self.config = config or CircuitBreakerConfig()
        
        self._state = CircuitBreakerState.CLOSED
        self._failure_count = 0
        self._success_count = 0
        self._last_failure_time: Optional[float] = None
        self._half_open_calls = 0
        self._lock = asyncio.Lock()
        
        logger.info(
            f"Circuit breaker '{name}' initialized",
            extra={
                "circuit_breaker": name,
                "failure_threshold": self.config.failure_threshold,
                "success_threshold": self.config.success_threshold,
                "timeout_seconds": self.config.timeout_seconds,
            }
        )
        
        # Update metrics
        try:
            metrics = get_metrics_registry()
            metrics.set_circuit_breaker_state(name, self._state)
        except RuntimeError:
            # Metrics not initialized, skip
            pass
    
    @property
    def state(self) -> CircuitBreakerState:
        """Get current circuit breaker state."""
        return self._state
    
    @property
    def is_closed(self) -> bool:
        """Check if circuit breaker is closed (normal operation)."""
        return self._state == CircuitBreakerState.CLOSED
    
    @property
    def is_open(self) -> bool:
        """Check if circuit breaker is open (failing fast)."""
        return self._state == CircuitBreakerState.OPEN
    
    @property
    def is_half_open(self) -> bool:
        """Check if circuit breaker is half-open (testing recovery)."""
        return self._state == CircuitBreakerState.HALF_OPEN
    
    async def _transition_to(self, new_state: CircuitBreakerState):
        """
        Transition to a new state.
        
        Args:
            new_state: New circuit breaker state
        """
        old_state = self._state
        
        if old_state == new_state:
            return
        
        self._state = new_state
        
        # Reset counters based on new state
        if new_state == CircuitBreakerState.CLOSED:
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
        elif new_state == CircuitBreakerState.OPEN:
            self._success_count = 0
            self._half_open_calls = 0
            self._last_failure_time = time.time()
        elif new_state == CircuitBreakerState.HALF_OPEN:
            self._failure_count = 0
            self._success_count = 0
            self._half_open_calls = 0
        
        logger.info(
            f"Circuit breaker '{self.name}' transitioned from {old_state.value} to {new_state.value}",
            extra={
                "circuit_breaker": self.name,
                "from_state": old_state.value,
                "to_state": new_state.value,
            }
        )
        
        # Update metrics
        try:
            metrics = get_metrics_registry()
            metrics.set_circuit_breaker_state(self.name, new_state)
            metrics.record_circuit_breaker_state_change(self.name, old_state, new_state)
        except RuntimeError:
            # Metrics not initialized, skip
            pass
    
    async def _check_timeout(self):
        """Check if timeout has elapsed and transition to half-open if needed."""
        if self._state == CircuitBreakerState.OPEN and self._last_failure_time:
            elapsed = time.time() - self._last_failure_time
            if elapsed >= self.config.timeout_seconds:
                await self._transition_to(CircuitBreakerState.HALF_OPEN)
    
    async def call(self, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """
        Execute a function protected by the circuit breaker.
        
        Args:
            func: Function to execute
            *args: Positional arguments for the function
            **kwargs: Keyword arguments for the function
            
        Returns:
            Result of the function call
            
        Raises:
            CircuitBreakerError: If circuit breaker is open
            Exception: Any exception raised by the function
        """
        async with self._lock:
            await self._check_timeout()
            
            # Check if we can make the call
            if self._state == CircuitBreakerState.OPEN:
                logger.warning(
                    f"Circuit breaker '{self.name}' is OPEN, failing fast",
                    extra={
                        "circuit_breaker": self.name,
                        "state": "open",
                        "failure_count": self._failure_count,
                    }
                )
                raise CircuitBreakerError(
                    f"Circuit breaker '{self.name}' is open. Service unavailable."
                )
            
            if self._state == CircuitBreakerState.HALF_OPEN:
                if self._half_open_calls >= self.config.half_open_max_calls:
                    logger.warning(
                        f"Circuit breaker '{self.name}' is HALF_OPEN with max concurrent calls reached",
                        extra={
                            "circuit_breaker": self.name,
                            "state": "half_open",
                            "concurrent_calls": self._half_open_calls,
                        }
                    )
                    raise CircuitBreakerError(
                        f"Circuit breaker '{self.name}' is half-open with max concurrent calls. Try again later."
                    )
                
                self._half_open_calls += 1
        
        # Execute the function outside the lock
        try:
            # Handle both sync and async functions
            if asyncio.iscoroutinefunction(func):
                result = await func(*args, **kwargs)
            else:
                result = func(*args, **kwargs)
            
            # Record success
            await self._on_success()
            return result
            
        except Exception as e:
            # Record failure
            await self._on_failure(e)
            raise
        finally:
            # Decrement half-open calls counter
            if self._state == CircuitBreakerState.HALF_OPEN:
                async with self._lock:
                    self._half_open_calls = max(0, self._half_open_calls - 1)
    
    async def _on_success(self):
        """Handle successful call."""
        async with self._lock:
            # Update metrics
            try:
                metrics = get_metrics_registry()
                metrics.record_circuit_breaker_success(self.name)
            except RuntimeError:
                pass
            
            if self._state == CircuitBreakerState.HALF_OPEN:
                self._success_count += 1
                
                logger.debug(
                    f"Circuit breaker '{self.name}' recorded success in HALF_OPEN state "
                    f"({self._success_count}/{self.config.success_threshold})",
                    extra={
                        "circuit_breaker": self.name,
                        "success_count": self._success_count,
                        "success_threshold": self.config.success_threshold,
                    }
                )
                
                if self._success_count >= self.config.success_threshold:
                    await self._transition_to(CircuitBreakerState.CLOSED)
                    logger.info(
                        f"Circuit breaker '{self.name}' recovered, transitioning to CLOSED",
                        extra={"circuit_breaker": self.name}
                    )
            
            elif self._state == CircuitBreakerState.CLOSED:
                # Reset failure count on success
                self._failure_count = 0
    
    async def _on_failure(self, exception: Exception):
        """
        Handle failed call.
        
        Args:
            exception: Exception that caused the failure
        """
        async with self._lock:
            # Update metrics
            try:
                metrics = get_metrics_registry()
                metrics.record_circuit_breaker_failure(self.name)
            except RuntimeError:
                pass
            
            if self._state == CircuitBreakerState.HALF_OPEN:
                # Any failure in half-open state reopens the circuit
                logger.warning(
                    f"Circuit breaker '{self.name}' failed in HALF_OPEN state, reopening circuit",
                    extra={
                        "circuit_breaker": self.name,
                        "exception_type": type(exception).__name__,
                        "exception_message": str(exception),
                    }
                )
                await self._transition_to(CircuitBreakerState.OPEN)
            
            elif self._state == CircuitBreakerState.CLOSED:
                self._failure_count += 1
                
                logger.warning(
                    f"Circuit breaker '{self.name}' recorded failure "
                    f"({self._failure_count}/{self.config.failure_threshold})",
                    extra={
                        "circuit_breaker": self.name,
                        "failure_count": self._failure_count,
                        "failure_threshold": self.config.failure_threshold,
                        "exception_type": type(exception).__name__,
                        "exception_message": str(exception),
                    }
                )
                
                if self._failure_count >= self.config.failure_threshold:
                    await self._transition_to(CircuitBreakerState.OPEN)
                    logger.error(
                        f"Circuit breaker '{self.name}' opened due to excessive failures",
                        extra={
                            "circuit_breaker": self.name,
                            "failure_count": self._failure_count,
                        }
                    )
    
    def __call__(self, func: Callable[..., T]) -> Callable[..., T]:
        """
        Decorator to protect a function with the circuit breaker.
        
        Args:
            func: Function to protect
            
        Returns:
            Wrapped function
            
        Example:
            circuit_breaker = CircuitBreaker("database")
            
            @circuit_breaker
            async def query_database():
                # Database query
                pass
        """
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            return await self.call(func, *args, **kwargs)
        
        return wrapper


class CircuitBreakerRegistry:
    """
    Registry for managing multiple circuit breakers.
    
    Provides centralized management of circuit breakers for different services.
    """
    
    def __init__(self):
        """Initialize circuit breaker registry."""
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._lock = asyncio.Lock()
        
        logger.info("Circuit breaker registry initialized")
    
    async def get_or_create(
        self,
        name: str,
        config: Optional[CircuitBreakerConfig] = None
    ) -> CircuitBreaker:
        """
        Get existing circuit breaker or create a new one.
        
        Args:
            name: Name of the circuit breaker
            config: Configuration for new circuit breaker (ignored if exists)
            
        Returns:
            CircuitBreaker instance
        """
        async with self._lock:
            if name not in self._breakers:
                self._breakers[name] = CircuitBreaker(name, config)
                logger.info(f"Created new circuit breaker: {name}")
            
            return self._breakers[name]
    
    def get(self, name: str) -> Optional[CircuitBreaker]:
        """
        Get existing circuit breaker.
        
        Args:
            name: Name of the circuit breaker
            
        Returns:
            CircuitBreaker instance or None if not found
        """
        return self._breakers.get(name)
    
    def get_all(self) -> Dict[str, CircuitBreaker]:
        """
        Get all circuit breakers.
        
        Returns:
            Dictionary of circuit breaker name to CircuitBreaker instance
        """
        return self._breakers.copy()
    
    async def reset(self, name: str):
        """
        Reset a circuit breaker to closed state.
        
        Args:
            name: Name of the circuit breaker
        """
        breaker = self.get(name)
        if breaker:
            async with breaker._lock:
                await breaker._transition_to(CircuitBreakerState.CLOSED)
                logger.info(f"Circuit breaker '{name}' manually reset to CLOSED")
    
    async def reset_all(self):
        """Reset all circuit breakers to closed state."""
        for name in list(self._breakers.keys()):
            await self.reset(name)
        
        logger.info("All circuit breakers reset to CLOSED")


# Global circuit breaker registry
_circuit_breaker_registry: Optional[CircuitBreakerRegistry] = None


def get_circuit_breaker_registry() -> CircuitBreakerRegistry:
    """
    Get global circuit breaker registry.
    
    Returns:
        CircuitBreakerRegistry singleton instance
    """
    global _circuit_breaker_registry
    if _circuit_breaker_registry is None:
        _circuit_breaker_registry = CircuitBreakerRegistry()
    
    return _circuit_breaker_registry


async def get_circuit_breaker(
    name: str,
    config: Optional[CircuitBreakerConfig] = None
) -> CircuitBreaker:
    """
    Get or create a circuit breaker from the global registry.
    
    Args:
        name: Name of the circuit breaker
        config: Configuration for new circuit breaker (ignored if exists)
        
    Returns:
        CircuitBreaker instance
    """
    registry = get_circuit_breaker_registry()
    return await registry.get_or_create(name, config)
