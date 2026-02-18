#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

"""
Demonstration of Prometheus metrics in Caracal Core.

This example shows how to:
1. Initialize the metrics registry
2. Record various types of metrics
3. Expose metrics via HTTP endpoint
4. Use context managers for timing operations
"""

import time
from decimal import Decimal
from prometheus_client import CollectorRegistry

from caracal.monitoring.metrics import (
    MetricsRegistry,
    initialize_metrics_registry,
    get_metrics_registry,
    PolicyDecisionType,
    DatabaseOperationType,
    CircuitBreakerState,
)


def simulate_gateway_requests(metrics: MetricsRegistry):
    """Simulate gateway proxy requests."""
    print("\n=== Simulating Gateway Requests ===")
    
    # Successful request
    with metrics.track_gateway_request_in_flight():
        time.sleep(0.01)  # Simulate processing
        metrics.record_gateway_request(
            method="GET",
            status_code=200,
            auth_method="jwt",
            duration_seconds=0.015
        )
    print("✓ Recorded successful GET request (200)")
    
    # Failed authentication
    metrics.record_auth_failure(
        auth_method="jwt",
        reason="invalid_token"
    )
    print("✓ Recorded authentication failure")
    
    # Replay attack blocked
    metrics.record_replay_block(reason="nonce_reused")
    print("✓ Recorded replay attack block")
    
    # Degraded mode request
    metrics.record_degraded_mode_request()
    print("✓ Recorded degraded mode request")


def simulate_policy_evaluations(metrics: MetricsRegistry):
    """Simulate policy evaluations."""
    print("\n=== Simulating Policy Evaluations ===")
    
    # Allowed policy decision
    with metrics.time_policy_evaluation(PolicyDecisionType.ALLOWED, "agent-123"):
        time.sleep(0.005)  # Simulate evaluation
    print("✓ Recorded allowed policy evaluation")
    
    # Denied policy decision
    with metrics.time_policy_evaluation(PolicyDecisionType.DENIED, "agent-456"):
        time.sleep(0.003)  # Simulate evaluation
    print("✓ Recorded denied policy evaluation")
    
    # Policy cache hit
    metrics.record_policy_cache_hit()
    print("✓ Recorded policy cache hit")
    
    # Policy cache miss
    metrics.record_policy_cache_miss()
    print("✓ Recorded policy cache miss")
    
    # Update cache size
    metrics.set_policy_cache_size(42)
    print("✓ Updated policy cache size")


def simulate_database_operations(metrics: MetricsRegistry):
    """Simulate database operations."""
    print("\n=== Simulating Database Operations ===")
    
    # Successful SELECT query
    with metrics.time_database_query(DatabaseOperationType.SELECT, "agent_identities"):
        time.sleep(0.002)  # Simulate query
    print("✓ Recorded SELECT query on agent_identities")
    
    # Successful INSERT query
    with metrics.time_database_query(DatabaseOperationType.INSERT, "ledger_events"):
        time.sleep(0.003)  # Simulate query
    print("✓ Recorded INSERT query on ledger_events")
    
    # Update connection pool stats
    metrics.update_connection_pool_stats(
        size=10,
        checked_out=3,
        overflow=1
    )
    print("✓ Updated connection pool statistics")
    
    # Record connection error
    metrics.record_database_connection_error("timeout")
    print("✓ Recorded database connection error")


    # Set active charges
    metrics.set_provisional_charges_active("agent-123", 5)
    print("✓ Updated active provisional charges count")
    
    # Cleanup job
    with metrics.time_provisional_charge_cleanup():
        time.sleep(0.05)  # Simulate cleanup
    print("✓ Recorded cleanup job duration")


def simulate_circuit_breakers(metrics: MetricsRegistry):
    """Simulate circuit breaker operations."""
    print("\n=== Simulating Circuit Breakers ===")
    
    # Set circuit breaker state
    metrics.set_circuit_breaker_state("database", CircuitBreakerState.CLOSED)
    print("✓ Set database circuit breaker to CLOSED")
    
    # Record failures
    metrics.record_circuit_breaker_failure("database")
    metrics.record_circuit_breaker_failure("database")
    print("✓ Recorded circuit breaker failures")
    
    # State change to OPEN
    metrics.record_circuit_breaker_state_change(
        "database",
        CircuitBreakerState.CLOSED,
        CircuitBreakerState.OPEN
    )
    metrics.set_circuit_breaker_state("database", CircuitBreakerState.OPEN)
    print("✓ Recorded circuit breaker state change to OPEN")
    
    # Record success
    metrics.record_circuit_breaker_success("database")
    print("✓ Recorded circuit breaker success")


def main():
    """Main demonstration."""
    print("=" * 60)
    print("Caracal Core Prometheus Metrics Demonstration")
    print("=" * 60)
    
    # Initialize metrics registry
    registry = CollectorRegistry()
    metrics = initialize_metrics_registry(registry)
    print("\n✓ Initialized metrics registry")
    
    # Simulate various operations
    simulate_gateway_requests(metrics)
    simulate_policy_evaluations(metrics)
    simulate_database_operations(metrics)

    simulate_circuit_breakers(metrics)
    
    # Generate metrics output
    print("\n=== Generating Metrics Output ===")
    output = metrics.generate_metrics()
    print(f"✓ Generated {len(output)} bytes of Prometheus metrics")
    
    # Display sample metrics
    print("\n=== Sample Metrics Output ===")
    lines = output.decode('utf-8').split('\n')
    
    # Show gateway metrics
    print("\nGateway Metrics:")
    for line in lines:
        if 'caracal_gateway' in line and not line.startswith('#'):
            print(f"  {line}")
    
    # Show policy metrics
    print("\nPolicy Metrics:")
    for line in lines:
        if 'caracal_policy' in line and not line.startswith('#'):
            print(f"  {line}")
    
    # Show database metrics
    print("\nDatabase Metrics:")
    for line in lines:
        if 'caracal_database' in line and not line.startswith('#'):
            print(f"  {line}")
    

    
    # Show circuit breaker metrics
    print("\nCircuit Breaker Metrics:")
    for line in lines:
        if 'caracal_circuit_breaker' in line and not line.startswith('#'):
            print(f"  {line}")
    
    print("\n" + "=" * 60)
    print("✅ Metrics demonstration complete!")
    print("=" * 60)
    print("\nTo expose these metrics via HTTP:")
    print("  1. Add /metrics endpoint to your FastAPI app")
    print("  2. Return metrics.generate_metrics() with content_type")
    print("  3. Configure Prometheus to scrape the endpoint")
    print("\nExample Prometheus scrape config:")
    print("  scrape_configs:")
    print("    - job_name: 'caracal-gateway'")
    print("      static_configs:")
    print("        - targets: ['localhost:8443']")
    print("      metrics_path: '/metrics'")


if __name__ == "__main__":
    main()
