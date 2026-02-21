"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Circuit Breaker Demo for Caracal Core.

This example demonstrates how to use circuit breakers to protect against
cascading failures in database operations, policy service, and external services.

"""

import asyncio
import random
from decimal import Decimal

from caracal.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerError,
    get_circuit_breaker,
)
from caracal.monitoring.metrics import initialize_metrics_registry


# Simulated services
class DatabaseService:
    """Simulated database service that can fail."""
    
    def __init__(self, failure_rate: float = 0.0):
        self.failure_rate = failure_rate
        self.call_count = 0
    
    async def query(self, query: str):
        """Execute a database query."""
        self.call_count += 1
        
        if random.random() < self.failure_rate:
            raise Exception("Database connection timeout")
        
        return {"result": f"Query result for: {query}"}


class PolicyService:
    """Simulated policy service that can fail."""
    
    def __init__(self, failure_rate: float = 0.0):
        self.failure_rate = failure_rate
        self.call_count = 0
    
    async def evaluate_policy(self, agent_id: str, cost: Decimal):
        """Evaluate budget policy."""
        self.call_count += 1
        
        if random.random() < self.failure_rate:
            raise Exception("Policy service unavailable")
        
        return {"allowed": True, "remaining_budget": Decimal("100.00")}


class ExternalAPIService:
    """Simulated external API service that can fail."""
    
    def __init__(self, failure_rate: float = 0.0):
        self.failure_rate = failure_rate
        self.call_count = 0
    
    async def call_api(self, endpoint: str):
        """Call external API."""
        self.call_count += 1
        
        if random.random() < self.failure_rate:
            raise Exception("External API timeout")
        
        return {"status": "success", "data": f"Response from {endpoint}"}


async def demo_database_circuit_breaker():
    """Demonstrate circuit breaker for database operations."""
    print("\n=== Database Circuit Breaker Demo ===\n")
    
    # Create database service with 80% failure rate
    db_service = DatabaseService(failure_rate=0.8)
    
    # Create circuit breaker for database
    config = CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout_seconds=2.0
    )
    db_breaker = await get_circuit_breaker("database", config)
    
    print(f"Initial state: {db_breaker.state.value}")
    print(f"Failure threshold: {config.failure_threshold}")
    print(f"Success threshold: {config.success_threshold}")
    print(f"Timeout: {config.timeout_seconds}s\n")
    
    # Make calls until circuit opens
    print("Making database calls (high failure rate)...")
    for i in range(10):
        try:
            result = await db_breaker.call(db_service.query, "SELECT * FROM agents")
            print(f"  Call {i+1}: ✓ Success - {result}")
        except CircuitBreakerError as e:
            print(f"  Call {i+1}: ✗ Circuit breaker open - {e}")
            break
        except Exception as e:
            print(f"  Call {i+1}: ✗ Failed - {e}")
        
        await asyncio.sleep(0.1)
    
    print(f"\nCircuit state after failures: {db_breaker.state.value}")
    
    # Wait for timeout
    print(f"\nWaiting {config.timeout_seconds}s for circuit to transition to half-open...")
    await asyncio.sleep(config.timeout_seconds + 0.1)
    
    # Reduce failure rate for recovery
    db_service.failure_rate = 0.1
    
    print("\nMaking calls after timeout (low failure rate)...")
    for i in range(5):
        try:
            result = await db_breaker.call(db_service.query, "SELECT * FROM agents")
            print(f"  Call {i+1}: ✓ Success - Circuit state: {db_breaker.state.value}")
        except CircuitBreakerError as e:
            print(f"  Call {i+1}: ✗ Circuit breaker open - {e}")
        except Exception as e:
            print(f"  Call {i+1}: ✗ Failed - {e}")
        
        await asyncio.sleep(0.1)
    
    print(f"\nFinal circuit state: {db_breaker.state.value}")
    print(f"Total database calls: {db_service.call_count}")


async def demo_policy_service_circuit_breaker():
    """Demonstrate circuit breaker for policy service."""
    print("\n=== Policy Service Circuit Breaker Demo ===\n")
    
    # Create policy service with 70% failure rate
    policy_service = PolicyService(failure_rate=0.7)
    
    # Create circuit breaker for policy service
    config = CircuitBreakerConfig(
        failure_threshold=5,
        success_threshold=3,
        timeout_seconds=3.0
    )
    policy_breaker = await get_circuit_breaker("policy_service", config)
    
    print(f"Initial state: {policy_breaker.state.value}")
    print(f"Failure threshold: {config.failure_threshold}")
    print(f"Success threshold: {config.success_threshold}\n")
    
    # Make calls until circuit opens
    print("Making policy evaluation calls (high failure rate)...")
    for i in range(15):
        try:
            result = await policy_breaker.call(
                policy_service.evaluate_policy,
                "agent-123",
                Decimal("10.00")
            )
            print(f"  Call {i+1}: ✓ Success - {result}")
        except CircuitBreakerError as e:
            print(f"  Call {i+1}: ✗ Circuit breaker open")
            if i >= 10:  # Stop after a few circuit breaker errors
                break
        except Exception as e:
            print(f"  Call {i+1}: ✗ Failed - {type(e).__name__}")
        
        await asyncio.sleep(0.05)
    
    print(f"\nCircuit state: {policy_breaker.state.value}")
    print(f"Total policy service calls: {policy_service.call_count}")


async def demo_external_api_circuit_breaker():
    """Demonstrate circuit breaker for external API."""
    print("\n=== External API Circuit Breaker Demo ===\n")
    
    # Create external API service with 60% failure rate
    api_service = ExternalAPIService(failure_rate=0.6)
    
    # Create circuit breaker for external API
    config = CircuitBreakerConfig(
        failure_threshold=4,
        success_threshold=2,
        timeout_seconds=2.0
    )
    api_breaker = await get_circuit_breaker("external_api", config)
    
    print(f"Initial state: {api_breaker.state.value}")
    print(f"Failure threshold: {config.failure_threshold}\n")
    
    # Make calls until circuit opens
    print("Making external API calls (high failure rate)...")
    for i in range(10):
        try:
            result = await api_breaker.call(api_service.call_api, "/api/v1/data")
            print(f"  Call {i+1}: ✓ Success")
        except CircuitBreakerError as e:
            print(f"  Call {i+1}: ✗ Circuit breaker open")
            if i >= 7:  # Stop after a few circuit breaker errors
                break
        except Exception as e:
            print(f"  Call {i+1}: ✗ Failed")
        
        await asyncio.sleep(0.05)
    
    print(f"\nCircuit state: {api_breaker.state.value}")
    print(f"Total API calls: {api_service.call_count}")


async def demo_circuit_breaker_decorator():
    """Demonstrate circuit breaker as a decorator."""
    print("\n=== Circuit Breaker Decorator Demo ===\n")
    
    # Create circuit breaker
    config = CircuitBreakerConfig(failure_threshold=2)
    breaker = CircuitBreaker("decorated_service", config)
    
    # Decorate a function
    @breaker
    async def risky_operation(should_fail: bool):
        """A risky operation that might fail."""
        if should_fail:
            raise Exception("Operation failed")
        return "Operation succeeded"
    
    print("Making calls to decorated function...")
    
    # Successful call
    try:
        result = await risky_operation(False)
        print(f"  Call 1: ✓ {result}")
    except Exception as e:
        print(f"  Call 1: ✗ {e}")
    
    # Failed calls
    for i in range(2, 4):
        try:
            result = await risky_operation(True)
            print(f"  Call {i}: ✓ {result}")
        except CircuitBreakerError as e:
            print(f"  Call {i}: ✗ Circuit breaker open")
        except Exception as e:
            print(f"  Call {i}: ✗ {e}")
    
    # Circuit should be open now
    print(f"\nCircuit state: {breaker.state.value}")
    
    # Try another call (should fail fast)
    try:
        result = await risky_operation(False)
        print(f"  Call 4: ✓ {result}")
    except CircuitBreakerError as e:
        print(f"  Call 4: ✗ Circuit breaker open (failing fast)")


async def demo_fail_closed_behavior():
    """Demonstrate fail-closed behavior when circuit breaker is open."""
    print("\n=== Fail-Closed Behavior Demo ===\n")
    
    print("Requirement 23.6: When circuit breakers open, the system SHALL fail closed")
    print("and deny operations.\n")
    
    # Create a service that always fails
    failing_service = DatabaseService(failure_rate=1.0)
    
    # Create circuit breaker with low threshold
    config = CircuitBreakerConfig(failure_threshold=2)
    breaker = await get_circuit_breaker("fail_closed_demo", config)
    
    print("Opening circuit breaker with failures...")
    for i in range(2):
        try:
            await breaker.call(failing_service.query, "SELECT * FROM agents")
        except Exception:
            print(f"  Failure {i+1} recorded")
    
    print(f"\nCircuit state: {breaker.state.value}")
    
    # Now try to make a call - should fail closed
    print("\nAttempting operation with open circuit breaker...")
    try:
        await breaker.call(failing_service.query, "SELECT * FROM agents")
        print("  ✗ Operation allowed (UNEXPECTED)")
    except CircuitBreakerError:
        print("  ✓ Operation denied (fail-closed behavior)")
    
    print("\nResult: System correctly fails closed when circuit breaker is open.")


async def main():
    """Run all circuit breaker demos."""
    print("=" * 60)
    print("Circuit Breaker Demo for Caracal Core")
    print("=" * 60)
    
    # Initialize metrics (optional, for production use)
    try:
        initialize_metrics_registry()
        print("\n✓ Metrics registry initialized\n")
    except Exception as e:
        print(f"\n⚠ Metrics registry not initialized: {e}\n")
    
    # Run demos
    await demo_database_circuit_breaker()
    await demo_policy_service_circuit_breaker()
    await demo_external_api_circuit_breaker()
    await demo_circuit_breaker_decorator()
    await demo_fail_closed_behavior()
    
    print("\n" + "=" * 60)
    print("Demo completed!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
