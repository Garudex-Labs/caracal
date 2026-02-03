"""
Prometheus metrics for Caracal Core v0.3.

This module provides comprehensive metrics for monitoring:
- Gateway request metrics (count, duration, status)
- Policy evaluation metrics (count, duration, decision)
- Database query metrics (count, duration, operation)
- Provisional charge metrics (active, expired)
- Circuit breaker metrics (state)
- Kafka consumer metrics (lag, processing time) [v0.3]
- Merkle tree metrics (batch processing, signing) [v0.3]
- Snapshot metrics (creation, size) [v0.3]
- Allowlist metrics (checks, matches, misses) [v0.3]
- Dead letter queue metrics (size) [v0.3]

Requirements: 17.7, 22.1, 24.1, 24.2, 24.3, 24.4, 24.5
"""

import time
from contextlib import contextmanager
from enum import Enum
from typing import Optional

from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    CollectorRegistry,
    generate_latest,
    CONTENT_TYPE_LATEST,
)

from caracal.logging_config import get_logger

logger = get_logger(__name__)


class PolicyDecisionType(str, Enum):
    """Policy decision types for metrics."""
    ALLOWED = "allowed"
    DENIED = "denied"
    ERROR = "error"


class DatabaseOperationType(str, Enum):
    """Database operation types for metrics."""
    SELECT = "select"
    INSERT = "insert"
    UPDATE = "update"
    DELETE = "delete"


class CircuitBreakerState(str, Enum):
    """Circuit breaker states for metrics."""
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class MetricsRegistry:
    """
    Central registry for all Prometheus metrics.
    
    Provides metrics for:
    - Gateway proxy requests
    - Policy evaluations
    - Database operations
    - Provisional charges
    - Circuit breakers
    
    Requirements: 17.7, 22.1
    """
    
    def __init__(self, registry: Optional[CollectorRegistry] = None):
        """
        Initialize metrics registry.
        
        Args:
            registry: Optional Prometheus CollectorRegistry (creates new if not provided)
        """
        self.registry = registry or CollectorRegistry()
        
        # Gateway Request Metrics
        self.gateway_requests_total = Counter(
            'caracal_gateway_requests_total',
            'Total number of gateway requests',
            ['method', 'status_code', 'auth_method'],
            registry=self.registry
        )
        
        self.gateway_request_duration_seconds = Histogram(
            'caracal_gateway_request_duration_seconds',
            'Gateway request duration in seconds',
            ['method', 'status_code'],
            buckets=(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0),
            registry=self.registry
        )
        
        self.gateway_requests_in_flight = Gauge(
            'caracal_gateway_requests_in_flight',
            'Number of gateway requests currently being processed',
            registry=self.registry
        )
        
        self.gateway_auth_failures_total = Counter(
            'caracal_gateway_auth_failures_total',
            'Total number of authentication failures',
            ['auth_method', 'reason'],
            registry=self.registry
        )
        
        self.gateway_replay_blocks_total = Counter(
            'caracal_gateway_replay_blocks_total',
            'Total number of requests blocked by replay protection',
            ['reason'],
            registry=self.registry
        )
        
        self.gateway_degraded_mode_requests_total = Counter(
            'caracal_gateway_degraded_mode_requests_total',
            'Total number of requests processed in degraded mode (using cached policies)',
            registry=self.registry
        )
        
        # Policy Evaluation Metrics
        self.policy_evaluations_total = Counter(
            'caracal_policy_evaluations_total',
            'Total number of policy evaluations',
            ['decision', 'agent_id'],
            registry=self.registry
        )
        
        self.policy_evaluation_duration_seconds = Histogram(
            'caracal_policy_evaluation_duration_seconds',
            'Policy evaluation duration in seconds',
            ['decision'],
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
            registry=self.registry
        )
        
        self.policy_cache_hits_total = Counter(
            'caracal_policy_cache_hits_total',
            'Total number of policy cache hits',
            registry=self.registry
        )
        
        self.policy_cache_misses_total = Counter(
            'caracal_policy_cache_misses_total',
            'Total number of policy cache misses',
            registry=self.registry
        )
        
        self.policy_cache_size = Gauge(
            'caracal_policy_cache_size',
            'Current number of policies in cache',
            registry=self.registry
        )
        
        self.policy_cache_evictions_total = Counter(
            'caracal_policy_cache_evictions_total',
            'Total number of policy cache evictions',
            registry=self.registry
        )
        
        # Database Query Metrics
        self.database_queries_total = Counter(
            'caracal_database_queries_total',
            'Total number of database queries',
            ['operation', 'table', 'status'],
            registry=self.registry
        )
        
        self.database_query_duration_seconds = Histogram(
            'caracal_database_query_duration_seconds',
            'Database query duration in seconds',
            ['operation', 'table'],
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
            registry=self.registry
        )
        
        self.database_connection_pool_size = Gauge(
            'caracal_database_connection_pool_size',
            'Current database connection pool size',
            registry=self.registry
        )
        
        self.database_connection_pool_checked_out = Gauge(
            'caracal_database_connection_pool_checked_out',
            'Number of database connections currently checked out',
            registry=self.registry
        )
        
        self.database_connection_pool_overflow = Gauge(
            'caracal_database_connection_pool_overflow',
            'Number of overflow database connections',
            registry=self.registry
        )
        
        self.database_connection_errors_total = Counter(
            'caracal_database_connection_errors_total',
            'Total number of database connection errors',
            ['error_type'],
            registry=self.registry
        )
        
        # Provisional Charge Metrics
        self.provisional_charges_created_total = Counter(
            'caracal_provisional_charges_created_total',
            'Total number of provisional charges created',
            ['agent_id'],
            registry=self.registry
        )
        
        self.provisional_charges_released_total = Counter(
            'caracal_provisional_charges_released_total',
            'Total number of provisional charges released',
            ['agent_id', 'reason'],
            registry=self.registry
        )
        
        self.provisional_charges_expired_total = Counter(
            'caracal_provisional_charges_expired_total',
            'Total number of provisional charges that expired',
            registry=self.registry
        )
        
        self.provisional_charges_active = Gauge(
            'caracal_provisional_charges_active',
            'Number of currently active provisional charges',
            ['agent_id'],
            registry=self.registry
        )
        
        self.provisional_charges_cleanup_duration_seconds = Histogram(
            'caracal_provisional_charges_cleanup_duration_seconds',
            'Duration of provisional charge cleanup job in seconds',
            buckets=(0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
            registry=self.registry
        )
        
        self.provisional_charges_cleanup_errors_total = Counter(
            'caracal_provisional_charges_cleanup_errors_total',
            'Total number of provisional charge cleanup errors',
            registry=self.registry
        )
        
        # Circuit Breaker Metrics
        self.circuit_breaker_state = Gauge(
            'caracal_circuit_breaker_state',
            'Circuit breaker state (0=closed, 1=open, 2=half_open)',
            ['name'],
            registry=self.registry
        )
        
        self.circuit_breaker_failures_total = Counter(
            'caracal_circuit_breaker_failures_total',
            'Total number of circuit breaker failures',
            ['name'],
            registry=self.registry
        )
        
        self.circuit_breaker_successes_total = Counter(
            'caracal_circuit_breaker_successes_total',
            'Total number of circuit breaker successes',
            ['name'],
            registry=self.registry
        )
        
        self.circuit_breaker_state_changes_total = Counter(
            'caracal_circuit_breaker_state_changes_total',
            'Total number of circuit breaker state changes',
            ['name', 'from_state', 'to_state'],
            registry=self.registry
        )
        
        logger.info("Metrics registry initialized with all metric collectors")
    
    # Gateway Request Metrics Methods
    
    def record_gateway_request(
        self,
        method: str,
        status_code: int,
        auth_method: str,
        duration_seconds: float
    ):
        """
        Record a gateway request.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            status_code: HTTP status code
            auth_method: Authentication method used
            duration_seconds: Request duration in seconds
        """
        self.gateway_requests_total.labels(
            method=method,
            status_code=status_code,
            auth_method=auth_method
        ).inc()
        
        self.gateway_request_duration_seconds.labels(
            method=method,
            status_code=status_code
        ).observe(duration_seconds)
    
    @contextmanager
    def track_gateway_request_in_flight(self):
        """Context manager to track in-flight gateway requests."""
        self.gateway_requests_in_flight.inc()
        try:
            yield
        finally:
            self.gateway_requests_in_flight.dec()
    
    def record_auth_failure(self, auth_method: str, reason: str):
        """
        Record an authentication failure.
        
        Args:
            auth_method: Authentication method that failed
            reason: Reason for failure
        """
        self.gateway_auth_failures_total.labels(
            auth_method=auth_method,
            reason=reason
        ).inc()
    
    def record_replay_block(self, reason: str):
        """
        Record a request blocked by replay protection.
        
        Args:
            reason: Reason for blocking
        """
        self.gateway_replay_blocks_total.labels(reason=reason).inc()
    
    def record_degraded_mode_request(self):
        """Record a request processed in degraded mode."""
        self.gateway_degraded_mode_requests_total.inc()
    
    # Policy Evaluation Metrics Methods
    
    def record_policy_evaluation(
        self,
        decision: PolicyDecisionType,
        agent_id: str,
        duration_seconds: float
    ):
        """
        Record a policy evaluation.
        
        Args:
            decision: Policy decision (allowed, denied, error)
            agent_id: Agent ID
            duration_seconds: Evaluation duration in seconds
        """
        self.policy_evaluations_total.labels(
            decision=decision.value,
            agent_id=agent_id
        ).inc()
        
        self.policy_evaluation_duration_seconds.labels(
            decision=decision.value
        ).observe(duration_seconds)
    
    @contextmanager
    def time_policy_evaluation(self, decision: PolicyDecisionType, agent_id: str):
        """
        Context manager to time policy evaluations.
        
        Args:
            decision: Policy decision type
            agent_id: Agent ID
        """
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.record_policy_evaluation(decision, agent_id, duration)
    
    def record_policy_cache_hit(self):
        """Record a policy cache hit."""
        self.policy_cache_hits_total.inc()
    
    def record_policy_cache_miss(self):
        """Record a policy cache miss."""
        self.policy_cache_misses_total.inc()
    
    def set_policy_cache_size(self, size: int):
        """
        Set the current policy cache size.
        
        Args:
            size: Number of policies in cache
        """
        self.policy_cache_size.set(size)
    
    def record_policy_cache_eviction(self):
        """Record a policy cache eviction."""
        self.policy_cache_evictions_total.inc()
    
    # Database Query Metrics Methods
    
    def record_database_query(
        self,
        operation: DatabaseOperationType,
        table: str,
        status: str,
        duration_seconds: float
    ):
        """
        Record a database query.
        
        Args:
            operation: Database operation type (select, insert, update, delete)
            table: Table name
            status: Query status (success, error)
            duration_seconds: Query duration in seconds
        """
        self.database_queries_total.labels(
            operation=operation.value,
            table=table,
            status=status
        ).inc()
        
        self.database_query_duration_seconds.labels(
            operation=operation.value,
            table=table
        ).observe(duration_seconds)
    
    @contextmanager
    def time_database_query(self, operation: DatabaseOperationType, table: str):
        """
        Context manager to time database queries.
        
        Args:
            operation: Database operation type
            table: Table name
        
        Yields:
            None
        """
        start_time = time.time()
        status = "success"
        try:
            yield
        except Exception:
            status = "error"
            raise
        finally:
            duration = time.time() - start_time
            self.record_database_query(operation, table, status, duration)
    
    def update_connection_pool_stats(
        self,
        size: int,
        checked_out: int,
        overflow: int
    ):
        """
        Update database connection pool statistics.
        
        Args:
            size: Current pool size
            checked_out: Number of connections checked out
            overflow: Number of overflow connections
        """
        self.database_connection_pool_size.set(size)
        self.database_connection_pool_checked_out.set(checked_out)
        self.database_connection_pool_overflow.set(overflow)
    
    def record_database_connection_error(self, error_type: str):
        """
        Record a database connection error.
        
        Args:
            error_type: Type of error (timeout, connection_failed, etc.)
        """
        self.database_connection_errors_total.labels(error_type=error_type).inc()
    
    # Provisional Charge Metrics Methods
    
    def record_provisional_charge_created(self, agent_id: str):
        """
        Record a provisional charge creation.
        
        Args:
            agent_id: Agent ID
        """
        self.provisional_charges_created_total.labels(agent_id=agent_id).inc()
    
    def record_provisional_charge_released(self, agent_id: str, reason: str):
        """
        Record a provisional charge release.
        
        Args:
            agent_id: Agent ID
            reason: Reason for release (final_charge, expired, manual)
        """
        self.provisional_charges_released_total.labels(
            agent_id=agent_id,
            reason=reason
        ).inc()
    
    def record_provisional_charge_expired(self):
        """Record a provisional charge expiration."""
        self.provisional_charges_expired_total.inc()
    
    def set_provisional_charges_active(self, agent_id: str, count: int):
        """
        Set the number of active provisional charges for an agent.
        
        Args:
            agent_id: Agent ID
            count: Number of active charges
        """
        self.provisional_charges_active.labels(agent_id=agent_id).set(count)
    
    @contextmanager
    def time_provisional_charge_cleanup(self):
        """Context manager to time provisional charge cleanup jobs."""
        start_time = time.time()
        try:
            yield
        except Exception:
            self.provisional_charges_cleanup_errors_total.inc()
            raise
        finally:
            duration = time.time() - start_time
            self.provisional_charges_cleanup_duration_seconds.observe(duration)
    
    # Circuit Breaker Metrics Methods
    
    def set_circuit_breaker_state(self, name: str, state: CircuitBreakerState):
        """
        Set circuit breaker state.
        
        Args:
            name: Circuit breaker name
            state: Circuit breaker state
        """
        # Map state to numeric value for Prometheus
        state_value = {
            CircuitBreakerState.CLOSED: 0,
            CircuitBreakerState.OPEN: 1,
            CircuitBreakerState.HALF_OPEN: 2,
        }[state]
        
        self.circuit_breaker_state.labels(name=name).set(state_value)
    
    def record_circuit_breaker_failure(self, name: str):
        """
        Record a circuit breaker failure.
        
        Args:
            name: Circuit breaker name
        """
        self.circuit_breaker_failures_total.labels(name=name).inc()
    
    def record_circuit_breaker_success(self, name: str):
        """
        Record a circuit breaker success.
        
        Args:
            name: Circuit breaker name
        """
        self.circuit_breaker_successes_total.labels(name=name).inc()
    
    def record_circuit_breaker_state_change(
        self,
        name: str,
        from_state: CircuitBreakerState,
        to_state: CircuitBreakerState
    ):
        """
        Record a circuit breaker state change.
        
        Args:
            name: Circuit breaker name
            from_state: Previous state
            to_state: New state
        """
        self.circuit_breaker_state_changes_total.labels(
            name=name,
            from_state=from_state.value,
            to_state=to_state.value
        ).inc()
    
    # Metrics Export
    
    def generate_metrics(self) -> bytes:
        """
        Generate Prometheus metrics in text format.
        
        Returns:
            Metrics in Prometheus text format
        """
        return generate_latest(self.registry)
    
    def get_content_type(self) -> str:
        """
        Get the content type for Prometheus metrics.
        
        Returns:
            Content type string
        """
        return CONTENT_TYPE_LATEST


# Global metrics registry instance
_metrics_registry: Optional[MetricsRegistry] = None


def get_metrics_registry() -> MetricsRegistry:
    """
    Get global metrics registry instance.
    
    Returns:
        MetricsRegistry singleton instance
    
    Raises:
        RuntimeError: If metrics registry not initialized
    """
    global _metrics_registry
    if _metrics_registry is None:
        raise RuntimeError(
            "Metrics registry not initialized. "
            "Call initialize_metrics_registry() first."
        )
    return _metrics_registry


def initialize_metrics_registry(registry: Optional[CollectorRegistry] = None) -> MetricsRegistry:
    """
    Initialize global metrics registry.
    
    Args:
        registry: Optional Prometheus CollectorRegistry
    
    Returns:
        Initialized MetricsRegistry
    """
    global _metrics_registry
    if _metrics_registry is not None:
        logger.warning("Metrics registry already initialized, reinitializing")
    
    _metrics_registry = MetricsRegistry(registry)
    logger.info("Global metrics registry initialized")
    return _metrics_registry
