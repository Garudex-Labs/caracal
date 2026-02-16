"""
Prometheus metrics for Caracal Core v0.5.

This module provides comprehensive metrics for monitoring:
- Gateway request metrics (count, duration, status)
- Policy evaluation metrics (count, duration, decision)
- Database query metrics (count, duration, operation)
- Circuit breaker metrics (state)
- Kafka consumer metrics (lag, processing time) [v0.3]
- Merkle tree metrics (batch processing, signing) [v0.3]
- Snapshot metrics (creation, size) [v0.3]
- Allowlist metrics (checks, matches, misses) [v0.3]
- Dead letter queue metrics (size) [v0.3]
- Authority enforcement metrics (validations, issuances, revocations) [v0.5]

Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 17.7, 22.1, 24.1, 24.2, 24.3, 24.4, 24.5
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
        
        # Kafka Consumer Metrics (v0.3)
        self.kafka_consumer_lag = Gauge(
            'caracal_kafka_consumer_lag',
            'Kafka consumer lag (messages behind) per topic and partition',
            ['consumer_group', 'topic', 'partition'],
            registry=self.registry
        )
        
        self.kafka_consumer_offset = Gauge(
            'caracal_kafka_consumer_offset',
            'Current Kafka consumer offset per topic and partition',
            ['consumer_group', 'topic', 'partition'],
            registry=self.registry
        )
        
        self.kafka_messages_consumed_total = Counter(
            'caracal_kafka_messages_consumed_total',
            'Total number of Kafka messages consumed',
            ['consumer_group', 'topic', 'status'],
            registry=self.registry
        )
        
        self.kafka_message_processing_duration_seconds = Histogram(
            'caracal_kafka_message_processing_duration_seconds',
            'Kafka message processing duration in seconds',
            ['consumer_group', 'topic'],
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
            registry=self.registry
        )
        
        self.kafka_consumer_errors_total = Counter(
            'caracal_kafka_consumer_errors_total',
            'Total number of Kafka consumer errors',
            ['consumer_group', 'topic', 'error_type'],
            registry=self.registry
        )
        
        self.kafka_consumer_rebalances_total = Counter(
            'caracal_kafka_consumer_rebalances_total',
            'Total number of Kafka consumer group rebalances',
            ['consumer_group'],
            registry=self.registry
        )
        
        # Merkle Tree Metrics (v0.3)
        self.merkle_batches_created_total = Counter(
            'caracal_merkle_batches_created_total',
            'Total number of Merkle batches created',
            registry=self.registry
        )
        
        self.merkle_batch_size = Histogram(
            'caracal_merkle_batch_size',
            'Number of events in Merkle batches',
            buckets=(10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000),
            registry=self.registry
        )
        
        self.merkle_batch_processing_duration_seconds = Histogram(
            'caracal_merkle_batch_processing_duration_seconds',
            'Merkle batch processing duration in seconds (tree computation + signing)',
            buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
            registry=self.registry
        )
        
        self.merkle_tree_computation_duration_seconds = Histogram(
            'caracal_merkle_tree_computation_duration_seconds',
            'Merkle tree computation duration in seconds',
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
            registry=self.registry
        )
        
        self.merkle_signing_duration_seconds = Histogram(
            'caracal_merkle_signing_duration_seconds',
            'Merkle root signing duration in seconds',
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5),
            registry=self.registry
        )
        
        self.merkle_verification_duration_seconds = Histogram(
            'caracal_merkle_verification_duration_seconds',
            'Merkle proof verification duration in seconds',
            buckets=(0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05),
            registry=self.registry
        )
        
        self.merkle_verification_failures_total = Counter(
            'caracal_merkle_verification_failures_total',
            'Total number of Merkle verification failures (tamper detected)',
            ['failure_type'],
            registry=self.registry
        )
        
        self.merkle_events_in_current_batch = Gauge(
            'caracal_merkle_events_in_current_batch',
            'Number of events in current Merkle batch (not yet signed)',
            registry=self.registry
        )
        
        # Snapshot Metrics (v0.3)
        self.snapshots_created_total = Counter(
            'caracal_snapshots_created_total',
            'Total number of ledger snapshots created',
            ['trigger'],
            registry=self.registry
        )
        
        self.snapshot_creation_duration_seconds = Histogram(
            'caracal_snapshot_creation_duration_seconds',
            'Snapshot creation duration in seconds',
            buckets=(1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0),
            registry=self.registry
        )
        
        self.snapshot_size_bytes = Histogram(
            'caracal_snapshot_size_bytes',
            'Snapshot size in bytes',
            buckets=(1024, 10240, 102400, 1048576, 10485760, 104857600, 1073741824),
            registry=self.registry
        )
        
        self.snapshot_event_count = Histogram(
            'caracal_snapshot_event_count',
            'Number of events in snapshot',
            buckets=(100, 1000, 10000, 100000, 1000000, 10000000),
            registry=self.registry
        )
        
        self.snapshot_recovery_duration_seconds = Histogram(
            'caracal_snapshot_recovery_duration_seconds',
            'Snapshot recovery duration in seconds',
            buckets=(1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0),
            registry=self.registry
        )
        
        # Allowlist Metrics (v0.3)
        self.allowlist_checks_total = Counter(
            'caracal_allowlist_checks_total',
            'Total number of allowlist checks',
            ['agent_id', 'result'],
            registry=self.registry
        )
        
        self.allowlist_matches_total = Counter(
            'caracal_allowlist_matches_total',
            'Total number of allowlist matches',
            ['agent_id', 'pattern_type'],
            registry=self.registry
        )
        
        self.allowlist_misses_total = Counter(
            'caracal_allowlist_misses_total',
            'Total number of allowlist misses (resource not allowed)',
            ['agent_id'],
            registry=self.registry
        )
        
        self.allowlist_check_duration_seconds = Histogram(
            'caracal_allowlist_check_duration_seconds',
            'Allowlist check duration in seconds',
            ['pattern_type'],
            buckets=(0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05),
            registry=self.registry
        )
        
        self.allowlist_cache_hits_total = Counter(
            'caracal_allowlist_cache_hits_total',
            'Total number of allowlist cache hits',
            registry=self.registry
        )
        
        self.allowlist_cache_misses_total = Counter(
            'caracal_allowlist_cache_misses_total',
            'Total number of allowlist cache misses',
            registry=self.registry
        )
        
        self.allowlist_patterns_active = Gauge(
            'caracal_allowlist_patterns_active',
            'Number of active allowlist patterns per agent',
            ['agent_id'],
            registry=self.registry
        )
        
        # Dead Letter Queue Metrics (v0.3)
        self.dlq_messages_total = Counter(
            'caracal_dlq_messages_total',
            'Total number of messages sent to dead letter queue',
            ['source_topic', 'error_type'],
            registry=self.registry
        )
        
        self.dlq_size = Gauge(
            'caracal_dlq_size',
            'Current number of messages in dead letter queue',
            registry=self.registry
        )
        
        self.dlq_oldest_message_age_seconds = Gauge(
            'caracal_dlq_oldest_message_age_seconds',
            'Age of oldest message in dead letter queue in seconds',
            registry=self.registry
        )
        
        # Policy Versioning Metrics (v0.3)
        self.policy_versions_created_total = Counter(
            'caracal_policy_versions_created_total',
            'Total number of policy versions created',
            ['change_type'],
            registry=self.registry
        )
        
        self.policy_version_queries_total = Counter(
            'caracal_policy_version_queries_total',
            'Total number of policy version history queries',
            ['query_type'],
            registry=self.registry
        )
        
        # Event Replay Metrics (v0.3)
        self.event_replay_started_total = Counter(
            'caracal_event_replay_started_total',
            'Total number of event replay operations started',
            ['source'],
            registry=self.registry
        )
        
        self.event_replay_events_processed = Counter(
            'caracal_event_replay_events_processed',
            'Total number of events processed during replay',
            ['source'],
            registry=self.registry
        )
        
        self.event_replay_duration_seconds = Histogram(
            'caracal_event_replay_duration_seconds',
            'Event replay duration in seconds',
            buckets=(10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0),
            registry=self.registry
        )
        
        # Authority Enforcement Metrics (v0.5)
        self.authority_mandate_validations_total = Counter(
            'caracal_authority_mandate_validations_total',
            'Total number of mandate validation attempts',
            ['principal_id', 'decision'],
            registry=self.registry
        )
        
        self.authority_mandate_validations_denied_total = Counter(
            'caracal_authority_mandate_validations_denied_total',
            'Total number of mandate validations denied',
            ['principal_id', 'denial_reason'],
            registry=self.registry
        )
        
        self.authority_mandate_validation_duration_seconds = Histogram(
            'caracal_authority_mandate_validation_duration_seconds',
            'Mandate validation duration in seconds',
            ['decision'],
            buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
            registry=self.registry
        )
        
        self.authority_mandate_issuances_total = Counter(
            'caracal_authority_mandate_issuances_total',
            'Total number of mandates issued',
            ['issuer_id', 'subject_id'],
            registry=self.registry
        )
        
        self.authority_mandate_revocations_total = Counter(
            'caracal_authority_mandate_revocations_total',
            'Total number of mandates revoked',
            ['revoker_id', 'cascade'],
            registry=self.registry
        )
        
        self.authority_ledger_events_total = Counter(
            'caracal_authority_ledger_events_total',
            'Total number of authority ledger events created',
            ['event_type'],
            registry=self.registry
        )
        
        self.authority_cache_hit_rate = Gauge(
            'caracal_authority_cache_hit_rate',
            'Authority mandate cache hit rate (0.0 to 1.0)',
            registry=self.registry
        )
        
        logger.info("Metrics registry initialized with all metric collectors (v0.2 + v0.3 + v0.5)")
    
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
    
    # Kafka Consumer Metrics Methods (v0.3)
    
    def update_kafka_consumer_lag(
        self,
        consumer_group: str,
        topic: str,
        partition: int,
        lag: int
    ):
        """
        Update Kafka consumer lag.
        
        Args:
            consumer_group: Consumer group ID
            topic: Topic name
            partition: Partition number
            lag: Number of messages behind
        """
        self.kafka_consumer_lag.labels(
            consumer_group=consumer_group,
            topic=topic,
            partition=str(partition)
        ).set(lag)
    
    def update_kafka_consumer_offset(
        self,
        consumer_group: str,
        topic: str,
        partition: int,
        offset: int
    ):
        """
        Update Kafka consumer offset.
        
        Args:
            consumer_group: Consumer group ID
            topic: Topic name
            partition: Partition number
            offset: Current offset
        """
        self.kafka_consumer_offset.labels(
            consumer_group=consumer_group,
            topic=topic,
            partition=str(partition)
        ).set(offset)
    
    def record_kafka_message_consumed(
        self,
        consumer_group: str,
        topic: str,
        status: str,
        duration_seconds: float
    ):
        """
        Record a Kafka message consumption.
        
        Args:
            consumer_group: Consumer group ID
            topic: Topic name
            status: Processing status (success, error)
            duration_seconds: Processing duration in seconds
        """
        self.kafka_messages_consumed_total.labels(
            consumer_group=consumer_group,
            topic=topic,
            status=status
        ).inc()
        
        self.kafka_message_processing_duration_seconds.labels(
            consumer_group=consumer_group,
            topic=topic
        ).observe(duration_seconds)
    
    @contextmanager
    def time_kafka_message_processing(self, consumer_group: str, topic: str):
        """
        Context manager to time Kafka message processing.
        
        Args:
            consumer_group: Consumer group ID
            topic: Topic name
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
            self.record_kafka_message_consumed(consumer_group, topic, status, duration)
    
    def record_kafka_consumer_error(
        self,
        consumer_group: str,
        topic: str,
        error_type: str
    ):
        """
        Record a Kafka consumer error.
        
        Args:
            consumer_group: Consumer group ID
            topic: Topic name
            error_type: Type of error
        """
        self.kafka_consumer_errors_total.labels(
            consumer_group=consumer_group,
            topic=topic,
            error_type=error_type
        ).inc()
    
    def record_kafka_consumer_rebalance(self, consumer_group: str):
        """
        Record a Kafka consumer group rebalance.
        
        Args:
            consumer_group: Consumer group ID
        """
        self.kafka_consumer_rebalances_total.labels(
            consumer_group=consumer_group
        ).inc()
    
    # Merkle Tree Metrics Methods (v0.3)
    
    def record_merkle_batch_created(
        self,
        batch_size: int,
        processing_duration_seconds: float,
        tree_computation_duration_seconds: float,
        signing_duration_seconds: float
    ):
        """
        Record a Merkle batch creation.
        
        Args:
            batch_size: Number of events in batch
            processing_duration_seconds: Total processing duration
            tree_computation_duration_seconds: Tree computation duration
            signing_duration_seconds: Signing duration
        """
        self.merkle_batches_created_total.inc()
        self.merkle_batch_size.observe(batch_size)
        self.merkle_batch_processing_duration_seconds.observe(processing_duration_seconds)
        self.merkle_tree_computation_duration_seconds.observe(tree_computation_duration_seconds)
        self.merkle_signing_duration_seconds.observe(signing_duration_seconds)
    
    @contextmanager
    def time_merkle_tree_computation(self):
        """Context manager to time Merkle tree computation."""
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.merkle_tree_computation_duration_seconds.observe(duration)
    
    @contextmanager
    def time_merkle_signing(self):
        """Context manager to time Merkle root signing."""
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.merkle_signing_duration_seconds.observe(duration)
    
    def record_merkle_verification(self, duration_seconds: float, success: bool, failure_type: Optional[str] = None):
        """
        Record a Merkle proof verification.
        
        Args:
            duration_seconds: Verification duration in seconds
            success: Whether verification succeeded
            failure_type: Type of failure if not successful
        """
        self.merkle_verification_duration_seconds.observe(duration_seconds)
        
        if not success and failure_type:
            self.merkle_verification_failures_total.labels(
                failure_type=failure_type
            ).inc()
    
    @contextmanager
    def time_merkle_verification(self):
        """Context manager to time Merkle proof verification."""
        start_time = time.time()
        success = True
        failure_type = None
        try:
            yield
        except Exception as e:
            success = False
            failure_type = type(e).__name__
            raise
        finally:
            duration = time.time() - start_time
            self.record_merkle_verification(duration, success, failure_type)
    
    def set_merkle_events_in_current_batch(self, count: int):
        """
        Set the number of events in current Merkle batch.
        
        Args:
            count: Number of events
        """
        self.merkle_events_in_current_batch.set(count)
    
    # Snapshot Metrics Methods (v0.3)
    
    def record_snapshot_created(
        self,
        trigger: str,
        duration_seconds: float,
        size_bytes: int,
        event_count: int
    ):
        """
        Record a snapshot creation.
        
        Args:
            trigger: What triggered the snapshot (scheduled, manual, recovery)
            duration_seconds: Creation duration in seconds
            size_bytes: Snapshot size in bytes
            event_count: Number of events in snapshot
        """
        self.snapshots_created_total.labels(trigger=trigger).inc()
        self.snapshot_creation_duration_seconds.observe(duration_seconds)
        self.snapshot_size_bytes.observe(size_bytes)
        self.snapshot_event_count.observe(event_count)
    
    @contextmanager
    def time_snapshot_creation(self, trigger: str):
        """
        Context manager to time snapshot creation.
        
        Args:
            trigger: What triggered the snapshot
        """
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            # Note: size and event_count will be recorded separately
            self.snapshots_created_total.labels(trigger=trigger).inc()
            self.snapshot_creation_duration_seconds.observe(duration)
    
    def record_snapshot_recovery(self, duration_seconds: float):
        """
        Record a snapshot recovery operation.
        
        Args:
            duration_seconds: Recovery duration in seconds
        """
        self.snapshot_recovery_duration_seconds.observe(duration_seconds)
    
    @contextmanager
    def time_snapshot_recovery(self):
        """Context manager to time snapshot recovery."""
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.record_snapshot_recovery(duration)
    
    # Allowlist Metrics Methods (v0.3)
    
    def record_allowlist_check(
        self,
        agent_id: str,
        result: str,
        pattern_type: Optional[str] = None,
        duration_seconds: Optional[float] = None
    ):
        """
        Record an allowlist check.
        
        Args:
            agent_id: Agent ID
            result: Check result (allowed, denied, no_allowlist)
            pattern_type: Pattern type if matched (regex, glob)
            duration_seconds: Check duration in seconds
        """
        self.allowlist_checks_total.labels(
            agent_id=agent_id,
            result=result
        ).inc()
        
        if result == "allowed" and pattern_type:
            self.allowlist_matches_total.labels(
                agent_id=agent_id,
                pattern_type=pattern_type
            ).inc()
        elif result == "denied":
            self.allowlist_misses_total.labels(agent_id=agent_id).inc()
        
        if duration_seconds and pattern_type:
            self.allowlist_check_duration_seconds.labels(
                pattern_type=pattern_type
            ).observe(duration_seconds)
    
    @contextmanager
    def time_allowlist_check(self, agent_id: str, pattern_type: str):
        """
        Context manager to time allowlist checks.
        
        Args:
            agent_id: Agent ID
            pattern_type: Pattern type (regex, glob)
        """
        start_time = time.time()
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.allowlist_check_duration_seconds.labels(
                pattern_type=pattern_type
            ).observe(duration)
    
    def record_allowlist_cache_hit(self):
        """Record an allowlist cache hit."""
        self.allowlist_cache_hits_total.inc()
    
    def record_allowlist_cache_miss(self):
        """Record an allowlist cache miss."""
        self.allowlist_cache_misses_total.inc()
    
    def set_allowlist_patterns_active(self, agent_id: str, count: int):
        """
        Set the number of active allowlist patterns for an agent.
        
        Args:
            agent_id: Agent ID
            count: Number of active patterns
        """
        self.allowlist_patterns_active.labels(agent_id=agent_id).set(count)
    
    # Dead Letter Queue Metrics Methods (v0.3)
    
    def record_dlq_message(self, source_topic: str, error_type: str):
        """
        Record a message sent to dead letter queue.
        
        Args:
            source_topic: Original topic the message came from
            error_type: Type of error that caused DLQ
        """
        self.dlq_messages_total.labels(
            source_topic=source_topic,
            error_type=error_type
        ).inc()
    
    def update_dlq_size(self, size: int):
        """
        Update dead letter queue size.
        
        Args:
            size: Current number of messages in DLQ
        """
        self.dlq_size.set(size)
    
    def update_dlq_oldest_message_age(self, age_seconds: float):
        """
        Update age of oldest message in DLQ.
        
        Args:
            age_seconds: Age in seconds
        """
        self.dlq_oldest_message_age_seconds.set(age_seconds)
    
    # Policy Versioning Metrics Methods (v0.3)
    
    def record_policy_version_created(self, change_type: str):
        """
        Record a policy version creation.
        
        Args:
            change_type: Type of change (created, modified, deactivated)
        """
        self.policy_versions_created_total.labels(change_type=change_type).inc()
    
    def record_policy_version_query(self, query_type: str):
        """
        Record a policy version history query.
        
        Args:
            query_type: Type of query (history, at_time, compare)
        """
        self.policy_version_queries_total.labels(query_type=query_type).inc()
    
    # Event Replay Metrics Methods (v0.3)
    
    def record_event_replay_started(self, source: str):
        """
        Record an event replay operation started.
        
        Args:
            source: Replay source (timestamp, snapshot)
        """
        self.event_replay_started_total.labels(source=source).inc()
    
    def record_event_replay_event_processed(self, source: str):
        """
        Record an event processed during replay.
        
        Args:
            source: Replay source (timestamp, snapshot)
        """
        self.event_replay_events_processed.labels(source=source).inc()
    
    def record_event_replay_completed(self, source: str, duration_seconds: float):
        """
        Record an event replay operation completed.
        
        Args:
            source: Replay source (timestamp, snapshot)
            duration_seconds: Replay duration in seconds
        """
        self.event_replay_duration_seconds.observe(duration_seconds)
    
    @contextmanager
    def time_event_replay(self, source: str):
        """
        Context manager to time event replay operations.
        
        Args:
            source: Replay source (timestamp, snapshot)
        """
        start_time = time.time()
        self.record_event_replay_started(source)
        try:
            yield
        finally:
            duration = time.time() - start_time
            self.record_event_replay_completed(source, duration)
    
    # Authority Enforcement Metrics Methods (v0.5)
    
    def record_authority_mandate_validation(
        self,
        principal_id: str,
        decision: str,
        duration_seconds: float,
        denial_reason: Optional[str] = None
    ):
        """
        Record a mandate validation attempt.
        
        Args:
            principal_id: Principal ID
            decision: Validation decision (allowed, denied)
            duration_seconds: Validation duration in seconds
            denial_reason: Reason for denial if denied
        """
        self.authority_mandate_validations_total.labels(
            principal_id=principal_id,
            decision=decision
        ).inc()
        
        self.authority_mandate_validation_duration_seconds.labels(
            decision=decision
        ).observe(duration_seconds)
        
        if decision == "denied" and denial_reason:
            self.authority_mandate_validations_denied_total.labels(
                principal_id=principal_id,
                denial_reason=denial_reason
            ).inc()
    
    @contextmanager
    def time_authority_mandate_validation(self, principal_id: str):
        """
        Context manager to time mandate validation.
        
        Args:
            principal_id: Principal ID
        
        Yields:
            Dictionary to store decision and denial_reason
        """
        start_time = time.time()
        result = {"decision": "denied", "denial_reason": "unknown"}
        try:
            yield result
        finally:
            duration = time.time() - start_time
            self.record_authority_mandate_validation(
                principal_id=principal_id,
                decision=result.get("decision", "denied"),
                duration_seconds=duration,
                denial_reason=result.get("denial_reason")
            )
    
    def record_authority_mandate_issuance(
        self,
        issuer_id: str,
        subject_id: str
    ):
        """
        Record a mandate issuance.
        
        Args:
            issuer_id: Issuer principal ID
            subject_id: Subject principal ID
        """
        self.authority_mandate_issuances_total.labels(
            issuer_id=issuer_id,
            subject_id=subject_id
        ).inc()
    
    def record_authority_mandate_revocation(
        self,
        revoker_id: str,
        cascade: bool
    ):
        """
        Record a mandate revocation.
        
        Args:
            revoker_id: Revoker principal ID
            cascade: Whether cascade revocation was used
        """
        self.authority_mandate_revocations_total.labels(
            revoker_id=revoker_id,
            cascade=str(cascade).lower()
        ).inc()
    
    def record_authority_ledger_event(self, event_type: str):
        """
        Record an authority ledger event creation.
        
        Args:
            event_type: Event type (issued, validated, denied, revoked)
        """
        self.authority_ledger_events_total.labels(
            event_type=event_type
        ).inc()
    
    def update_authority_cache_hit_rate(self, hit_rate: float):
        """
        Update authority mandate cache hit rate.
        
        Args:
            hit_rate: Hit rate as a float between 0.0 and 1.0
        """
        self.authority_cache_hit_rate.set(hit_rate)
    
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
