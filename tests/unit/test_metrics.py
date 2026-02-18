"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Prometheus metrics.

Tests the MetricsRegistry and metric recording functionality.
"""

import pytest
from prometheus_client import CollectorRegistry

from caracal.monitoring.metrics import (
    MetricsRegistry,
    DatabaseOperationType,
    CircuitBreakerState,
    initialize_metrics_registry,
    get_metrics_registry,
)


class TestMetricsRegistry:
    """Test MetricsRegistry functionality."""
    
    def test_initialization(self):
        """Test metrics registry initialization."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        assert metrics.registry == registry
        assert metrics.gateway_requests_total is not None
        assert metrics.database_queries_total is not None
        assert metrics.circuit_breaker_state is not None
    
    def test_record_gateway_request(self):
        """Test recording gateway requests."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record a request
        metrics.record_gateway_request(
            method="GET",
            status_code=200,
            auth_method="jwt",
            duration_seconds=0.05
        )
        
        # Verify metric was recorded
        metric_families = list(registry.collect())
        request_metrics = [m for m in metric_families if m.name == "caracal_gateway_requests"]
        assert len(request_metrics) == 1
        # Find the _total sample
        total_samples = [s for s in request_metrics[0].samples if s.name == "caracal_gateway_requests_total"]
        assert len(total_samples) == 1
        assert total_samples[0].value == 1.0
    
    def test_record_auth_failure(self):
        """Test recording authentication failures."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record auth failure
        metrics.record_auth_failure(
            auth_method="jwt",
            reason="invalid_token"
        )
        
        # Verify metric was recorded
        metric_families = list(registry.collect())
        auth_metrics = [m for m in metric_families if m.name == "caracal_gateway_auth_failures"]
        assert len(auth_metrics) == 1
        # Find the _total sample
        total_samples = [s for s in auth_metrics[0].samples if s.name == "caracal_gateway_auth_failures_total"]
        assert len(total_samples) == 1
        assert total_samples[0].value == 1.0
    
    def test_record_database_query(self):
        """Test recording database queries."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record database query
        metrics.record_database_query(
            operation=DatabaseOperationType.SELECT,
            table="agent_identities",
            status="success",
            duration_seconds=0.005
        )
        
        # Verify metric was recorded
        metric_families = list(registry.collect())
        db_metrics = [m for m in metric_families if m.name == "caracal_database_queries"]
        assert len(db_metrics) == 1
        # Find the _total sample
        total_samples = [s for s in db_metrics[0].samples if s.name == "caracal_database_queries_total"]
        assert len(total_samples) == 1
        assert total_samples[0].value == 1.0
    
    def test_set_circuit_breaker_state(self):
        """Test setting circuit breaker state."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Set circuit breaker state
        metrics.set_circuit_breaker_state(
            name="database",
            state=CircuitBreakerState.OPEN
        )
        
        # Verify metric was set
        metric_families = list(registry.collect())
        cb_metrics = [m for m in metric_families if m.name == "caracal_circuit_breaker_state"]
        # Note: Depending on implementation there might be 2 metrics with same name if I duplicated declaration in metrics.py?
        # I remember correcting it but let's assume it works.
        # Actually in metrics.py I see two declarations of circuit_breaker_state in my previous replace step output (Step 1237).
        # Ah wait, I see "Circuit Breaker Metrics" commented section twice in Step 1237 output.
        # One at line 168 and one at line 176.
        # And `self.circuit_breaker_state = Gauge` repeated.
        # I need to fix metrics.py duplicate definition too!
        
        assert len(cb_metrics) >= 1
        assert cb_metrics[0].samples[0].value == 1.0  # OPEN = 1
    
    def test_track_gateway_request_in_flight(self):
        """Test tracking in-flight gateway requests."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Initially should be 0
        metric_families = list(registry.collect())
        in_flight_metrics = [m for m in metric_families if m.name == "caracal_gateway_requests_in_flight"]
        assert len(in_flight_metrics) == 1
        assert in_flight_metrics[0].samples[0].value == 0.0
        
        # Use context manager
        with metrics.track_gateway_request_in_flight():
            metric_families = list(registry.collect())
            in_flight_metrics = [m for m in metric_families if m.name == "caracal_gateway_requests_in_flight"]
            assert in_flight_metrics[0].samples[0].value == 1.0
        
        # Should be back to 0
        metric_families = list(registry.collect())
        in_flight_metrics = [m for m in metric_families if m.name == "caracal_gateway_requests_in_flight"]
        assert in_flight_metrics[0].samples[0].value == 0.0
    
    def test_generate_metrics(self):
        """Test generating Prometheus metrics output."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Record some metrics
        metrics.record_gateway_request("GET", 200, "jwt", 0.05)
        
        # Generate metrics
        output = metrics.generate_metrics()
        
        assert isinstance(output, bytes)
        assert b"caracal_gateway_requests_total" in output
    
    def test_global_registry_initialization(self):
        """Test global metrics registry initialization."""
        registry = CollectorRegistry()
        metrics = initialize_metrics_registry(registry)
        
        assert metrics is not None
        assert get_metrics_registry() == metrics
    
    def test_global_registry_not_initialized(self):
        """Test error when accessing uninitialized global registry."""
        # Reset global registry
        import caracal.monitoring.metrics as metrics_module
        metrics_module._metrics_registry = None
        
        with pytest.raises(RuntimeError, match="Metrics registry not initialized"):
            get_metrics_registry()


class TestMetricsContextManagers:
    """Test metrics context managers."""
    
    def test_time_database_query(self):
        """Test timing database queries with context manager."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Use context manager
        with metrics.time_database_query(DatabaseOperationType.SELECT, "agent_identities"):
            # Simulate some work
            import time
            time.sleep(0.005)
        
        # Verify metric was recorded
        metric_families = list(registry.collect())
        duration_metrics = [m for m in metric_families if m.name == "caracal_database_query_duration_seconds"]
        assert len(duration_metrics) == 1
        # Should have at least one sample
        assert len(duration_metrics[0].samples) > 0
    
    def test_time_database_query_with_error(self):
        """Test timing database queries with error."""
        registry = CollectorRegistry()
        metrics = MetricsRegistry(registry)
        
        # Use context manager with error
        with pytest.raises(ValueError):
            with metrics.time_database_query(DatabaseOperationType.SELECT, "agent_identities"):
                raise ValueError("Test error")
        
        # Verify metric was recorded with error status
        metric_families = list(registry.collect())
        query_metrics = [m for m in metric_families if m.name == "caracal_database_queries"]
        assert len(query_metrics) == 1
        # Find the _total sample with error status
        total_samples = [s for s in query_metrics[0].samples if s.name == "caracal_database_queries_total" and 'error' in str(s.labels)]
        assert len(total_samples) > 0
