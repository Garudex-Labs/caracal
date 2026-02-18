"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for v0.3 monitoring features.

Tests Prometheus metrics and structured logging for v0.3 features.
"""

import logging
import pytest
from prometheus_client import CollectorRegistry

from caracal.monitoring.metrics import MetricsRegistry
from caracal.logging_config import (
    get_logger,
    log_merkle_root_computation,
    log_policy_version_change,
    log_allowlist_check,
    log_event_replay,
    log_snapshot_operation,
    log_dlq_event,
)


class TestV03Metrics:
    """Test v0.3 Prometheus metrics."""
    
    def test_merkle_tree_metrics(self):
        """Test Merkle tree metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record batch created
        metrics.record_merkle_batch_created(
            batch_size=1000,
            processing_duration_seconds=0.5,
            tree_computation_duration_seconds=0.05,
            signing_duration_seconds=0.01
        )
        
        # Record verification
        metrics.record_merkle_verification(0.001, True)
        
        # Record verification failure
        metrics.record_merkle_verification(0.002, False, "root_mismatch")
        
        # Set events in current batch
        metrics.set_merkle_events_in_current_batch(500)
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_merkle_batches_created" in metric_names
        assert "caracal_merkle_batch_size" in metric_names
        assert "caracal_merkle_tree_computation_duration_seconds" in metric_names
        assert "caracal_merkle_signing_duration_seconds" in metric_names
        assert "caracal_merkle_verification_duration_seconds" in metric_names
        assert "caracal_merkle_verification_failures" in metric_names
        assert "caracal_merkle_events_in_current_batch" in metric_names
    
    def test_snapshot_metrics(self):
        """Test snapshot metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record snapshot created
        metrics.record_snapshot_created(
            trigger="scheduled",
            duration_seconds=30.0,
            size_bytes=1048576,
            event_count=10000
        )
        
        # Record snapshot recovery
        metrics.record_snapshot_recovery(60.0)
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_snapshots_created" in metric_names
        assert "caracal_snapshot_creation_duration_seconds" in metric_names
        assert "caracal_snapshot_size_bytes" in metric_names
        assert "caracal_snapshot_event_count" in metric_names
        assert "caracal_snapshot_recovery_duration_seconds" in metric_names
    
    def test_allowlist_metrics(self):
        """Test allowlist metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record allowlist check
        metrics.record_allowlist_check("agent-123", "allowed", "regex", 0.001)
        metrics.record_allowlist_check("agent-123", "denied")
        
        # Record cache hits/misses
        metrics.record_allowlist_cache_hit()
        metrics.record_allowlist_cache_miss()
        
        # Set active patterns
        metrics.set_allowlist_patterns_active("agent-123", 5)
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_allowlist_checks" in metric_names
        assert "caracal_allowlist_matches" in metric_names
        assert "caracal_allowlist_misses" in metric_names
        assert "caracal_allowlist_check_duration_seconds" in metric_names
        assert "caracal_allowlist_cache_hits" in metric_names
        assert "caracal_allowlist_patterns_active" in metric_names
    
    def test_dlq_metrics(self):
        """Test dead letter queue metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record DLQ message
        metrics.record_dlq_message("caracal.metering.events", "processing_error")
        
        # Update DLQ size
        metrics.update_dlq_size(150)
        
        # Update oldest message age
        metrics.update_dlq_oldest_message_age(3600.0)
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_dlq_messages" in metric_names
        assert "caracal_dlq_size" in metric_names
        assert "caracal_dlq_oldest_message_age_seconds" in metric_names
    
    def test_policy_versioning_metrics(self):
        """Test policy versioning metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record policy version created
        metrics.record_policy_version_created("modified")
        
        # Record policy version query
        metrics.record_policy_version_query("history")
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_policy_versions_created" in metric_names
        assert "caracal_policy_version_queries" in metric_names
    
    def test_event_replay_metrics(self):
        """Test event replay metrics."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record replay started
        metrics.record_event_replay_started("timestamp")
        
        # Record events processed
        metrics.record_event_replay_event_processed("timestamp")
        
        # Record replay completed
        metrics.record_event_replay_completed("timestamp", 120.0)
        
        # Verify metrics exist
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        
        assert "caracal_event_replay_started" in metric_names
        assert "caracal_event_replay_events_processed" in metric_names
        assert "caracal_event_replay_duration_seconds" in metric_names


class TestV03StructuredLogging:
    """Test v0.3 structured logging functions."""
    
    def test_log_merkle_root_computation(self, capsys):
        """Test Merkle root computation logging."""
        logger = get_logger(__name__)
        
        log_merkle_root_computation(
            logger,
            batch_id="batch-123",
            event_count=1000,
            merkle_root="abc123",
            duration_ms=50.5
        )
        
        # Verify log was created (basic check)
        captured = capsys.readouterr()
        assert "merkle_root_computation" in captured.out
        assert "batch_id=batch-123" in captured.out
    
    def test_log_policy_version_change(self, capsys):
        """Test policy version change logging."""
        logger = get_logger(__name__)
        
        log_policy_version_change(
            logger,
            policy_id="policy-456",
            agent_id="agent-123",
            change_type="modified",
            version_number=2,
            changed_by="admin@example.com",
            change_reason="Increase authority scope",
            before_values={"limit_amount": "100.00"},
            after_values={"limit_amount": "200.00"}
        )
        
        captured = capsys.readouterr()
        assert "policy_version_change" in captured.out
        assert "policy_id=policy-456" in captured.out
    
    def test_log_allowlist_check(self, capsys):
        """Test allowlist check logging."""
        logger = get_logger(__name__)
        
        log_allowlist_check(
            logger,
            agent_id="agent-123",
            resource="https://api.openai.com/v1/chat",
            result="allowed",
            matched_pattern="^https://api\\.openai\\.com/.*$",
            pattern_type="regex",
            duration_ms=0.8
        )
        
        captured = capsys.readouterr()
        assert "allowlist_check" in captured.out
        assert "agent_id=agent-123" in captured.out
    
    def test_log_event_replay(self, capsys):
        """Test event replay logging."""
        logger = get_logger(__name__)
        
        log_event_replay(
            logger,
            replay_id="replay-789",
            source="timestamp",
            start_timestamp="2024-01-01T00:00:00Z",
            events_processed=5000,
            duration_seconds=120.5,
            status="completed"
        )
        
        captured = capsys.readouterr()
        assert "event_replay" in captured.out
        assert "replay_id=replay-789" in captured.out
    
    def test_log_snapshot_operation(self, capsys):
        """Test snapshot operation logging."""
        logger = get_logger(__name__)
        
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
        
        captured = capsys.readouterr()
        assert "snapshot_operation" in captured.out
        assert "snapshot_id=snapshot-101" in captured.out
    
    def test_log_dlq_event(self, capsys):
        """Test DLQ event logging."""
        logger = get_logger(__name__)
        
        log_dlq_event(
            logger,
            source_topic="caracal.metering.events",
            source_partition=0,
            source_offset=1000,
            error_type="processing_error",
            error_message="Failed to parse event",
            retry_count=3
        )
        
        captured = capsys.readouterr()
        assert "dlq_event" in captured.out
        assert "error_type=processing_error" in captured.out


class TestMetricsContextManagers:
    """Test metrics context managers."""
    
    def test_time_merkle_tree_computation(self):
        """Test Merkle tree computation timing context manager."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        with metrics.time_merkle_tree_computation():
            pass  # Simulate computation
        
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        assert "caracal_merkle_tree_computation_duration_seconds" in metric_names
    
    def test_time_merkle_signing(self):
        """Test Merkle signing timing context manager."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        with metrics.time_merkle_signing():
            pass  # Simulate signing
        
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        assert "caracal_merkle_signing_duration_seconds" in metric_names
    
    def test_time_snapshot_creation(self):
        """Test snapshot creation timing context manager."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        with metrics.time_snapshot_creation("manual"):
            pass  # Simulate snapshot creation
        
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        assert "caracal_snapshot_creation_duration_seconds" in metric_names
    
    def test_time_event_replay(self):
        """Test event replay timing context manager."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        with metrics.time_event_replay("timestamp"):
            pass  # Simulate replay
        
        metric_families = list(registry.collect())
        metric_names = [m.name for m in metric_families]
        assert "caracal_event_replay_duration_seconds" in metric_names
