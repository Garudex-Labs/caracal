"""
Demo of Caracal Core v0.3 monitoring and observability features.

This example demonstrates:
1. Initializing Prometheus metrics
2. Recording metrics (Merkle, snapshots, allowlists, DLQ)
3. Using structured logging for v0.3 features
4. Starting metrics HTTP server for Prometheus scraping
"""

import time
from caracal.monitoring import (
    initialize_metrics_registry,
    get_metrics_registry,
    start_metrics_server,
)
from caracal.logging_config import (
    setup_logging,
    get_logger,
    log_merkle_root_computation,
    log_merkle_signature,
    log_policy_version_change,
    log_allowlist_check,
    log_event_replay,
    log_snapshot_operation,
    log_dlq_event,
)


def demo_merkle_metrics():
    """Demo Merkle tree metrics."""
    print("\n=== Merkle Tree Metrics Demo ===")
    
    metrics = get_metrics_registry()
    
    # Simulate batch creation
    print("Recording Merkle batch creation...")
    metrics.record_merkle_batch_created(
        batch_size=1000,
        processing_duration_seconds=0.5,
        tree_computation_duration_seconds=0.05,
        signing_duration_seconds=0.01
    )
    
    # Simulate verification
    print("Recording Merkle verification...")
    with metrics.time_merkle_verification():
        time.sleep(0.001)  # Simulate verification
    
    # Simulate current batch
    print("Setting events in current batch...")
    metrics.set_merkle_events_in_current_batch(500)
    
    print("✓ Merkle tree metrics recorded")


def demo_snapshot_metrics():
    """Demo snapshot metrics."""
    print("\n=== Snapshot Metrics Demo ===")
    
    metrics = get_metrics_registry()
    
    # Simulate snapshot creation
    print("Recording snapshot creation...")
    metrics.record_snapshot_created(
        trigger="scheduled",
        duration_seconds=30.0,
        size_bytes=1048576,  # 1 MB
        event_count=10000
    )
    
    # Simulate snapshot recovery
    print("Recording snapshot recovery...")
    with metrics.time_snapshot_recovery():
        time.sleep(0.1)  # Simulate recovery
    
    print("✓ Snapshot metrics recorded")


def demo_allowlist_metrics():
    """Demo allowlist metrics."""
    print("\n=== Allowlist Metrics Demo ===")
    
    metrics = get_metrics_registry()
    
    # Simulate allowlist checks
    print("Recording allowlist checks...")
    metrics.record_allowlist_check(
        agent_id="agent-123",
        result="allowed",
        pattern_type="regex",
        duration_seconds=0.001
    )
    
    metrics.record_allowlist_check(
        agent_id="agent-456",
        result="denied"
    )
    
    # Simulate cache hits/misses
    print("Recording cache hits/misses...")
    metrics.record_allowlist_cache_hit()
    metrics.record_allowlist_cache_miss()
    
    # Set active patterns
    print("Setting active patterns...")
    metrics.set_allowlist_patterns_active("agent-123", 5)
    
    print("✓ Allowlist metrics recorded")


def demo_dlq_metrics():
    """Demo dead letter queue metrics."""
    print("\n=== Dead Letter Queue Metrics Demo ===")
    
    metrics = get_metrics_registry()
    
    # Simulate DLQ message
    print("Recording DLQ message...")
    metrics.record_dlq_message(
        source_topic="caracal.metering.events",
        error_type="processing_error"
    )
    
    # Update DLQ size
    print("Updating DLQ size...")
    metrics.update_dlq_size(150)
    
    # Update oldest message age
    print("Updating oldest message age...")
    metrics.update_dlq_oldest_message_age(3600.0)  # 1 hour
    
    print("✓ DLQ metrics recorded")


def demo_structured_logging():
    """Demo structured logging for v0.3 features."""
    print("\n=== Structured Logging Demo ===")
    
    logger = get_logger(__name__)
    
    # Log Merkle root computation
    print("Logging Merkle root computation...")
    log_merkle_root_computation(
        logger,
        batch_id="batch-123",
        event_count=1000,
        merkle_root="abc123def456...",
        duration_ms=50.5
    )
    
    # Log Merkle signature
    print("Logging Merkle signature...")
    log_merkle_signature(
        logger,
        batch_id="batch-123",
        merkle_root="abc123def456...",
        signature="sig789xyz...",
        signing_backend="software",
        duration_ms=10.2
    )
    
    # Log policy version change
    print("Logging policy version change...")
    log_policy_version_change(
        logger,
        policy_id="policy-456",
        agent_id="agent-123",
        change_type="modified",
        version_number=2,
        changed_by="admin@example.com",
        change_reason="Increase budget limit",
        before_values={"limit_amount": "100.00", "time_window": "daily"},
        after_values={"limit_amount": "200.00", "time_window": "daily"}
    )
    
    # Log allowlist check
    print("Logging allowlist check...")
    log_allowlist_check(
        logger,
        agent_id="agent-123",
        resource="https://api.openai.com/v1/chat/completions",
        result="allowed",
        matched_pattern="^https://api\\.openai\\.com/.*$",
        pattern_type="regex",
        duration_ms=0.8
    )
    
    # Log event replay
    print("Logging event replay...")
    log_event_replay(
        logger,
        replay_id="replay-789",
        source="timestamp",
        start_timestamp="2024-01-01T00:00:00Z",
        events_processed=5000,
        duration_seconds=120.5,
        status="completed"
    )
    
    # Log snapshot operation
    print("Logging snapshot operation...")
    log_snapshot_operation(
        logger,
        snapshot_id="snapshot-101",
        operation="create",
        trigger="scheduled",
        event_count=10000,
        size_bytes=1048576,
        duration_seconds=30.0,
        status="completed"
    )
    
    # Log DLQ event
    print("Logging DLQ event...")
    log_dlq_event(
        logger,
        source_topic="caracal.metering.events",
        source_partition=0,
        source_offset=1000,
        error_type="processing_error",
        error_message="Failed to parse event",
        retry_count=3
    )
    
    print("✓ Structured logging completed")


def main():
    """Run all monitoring demos."""
    print("=" * 60)
    print("Caracal Core v0.3 Monitoring Demo")
    print("=" * 60)
    
    # Setup logging
    print("\nSetting up structured logging...")
    setup_logging(level="INFO", json_format=False)
    
    # Initialize metrics
    print("Initializing Prometheus metrics registry...")
    initialize_metrics_registry()
    
    # Start metrics HTTP server
    print("Starting Prometheus metrics HTTP server...")
    server = start_metrics_server(host="0.0.0.0", port=9090)
    print(f"✓ Metrics available at: {server.get_url()}")
    
    # Run demos
    demo_merkle_metrics()
    demo_snapshot_metrics()
    demo_allowlist_metrics()
    demo_dlq_metrics()
    demo_structured_logging()
    
    print("\n" + "=" * 60)
    print("Demo completed successfully!")
    print("=" * 60)
    print(f"\nMetrics endpoint: {server.get_url()}")
    print("You can now scrape metrics with Prometheus or view them in a browser.")
    print("\nPress Ctrl+C to stop the metrics server...")
    
    try:
        # Keep server running
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\nStopping metrics server...")
        server.stop()
        print("✓ Server stopped")


if __name__ == "__main__":
    main()
