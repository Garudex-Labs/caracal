"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the Prometheus metrics registry.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from prometheus_client import CollectorRegistry

from caracal.monitoring.metrics import (
    CircuitBreakerState,
    DatabaseOperationType,
    MetricsRegistry,
    get_metrics_registry,
    initialize_metrics_registry,
)


@pytest.fixture
def registry():
    return MetricsRegistry(registry=CollectorRegistry())


@pytest.mark.unit
class TestMetricsRegistryInit:
    def test_creates_with_custom_registry(self):
        r = CollectorRegistry()
        m = MetricsRegistry(registry=r)
        assert m.registry is r

    def test_creates_with_default_registry(self):
        m = MetricsRegistry()
        assert m.registry is not None

    def test_all_counters_present(self, registry):
        assert registry.gateway_requests_total is not None
        assert registry.gateway_auth_failures_total is not None
        assert registry.gateway_replay_blocks_total is not None
        assert registry.gateway_degraded_mode_requests_total is not None
        assert registry.database_queries_total is not None
        assert registry.database_connection_errors_total is not None
        assert registry.circuit_breaker_failures_total is not None
        assert registry.circuit_breaker_successes_total is not None
        assert registry.authority_mandate_validations_total is not None
        assert registry.authority_mandate_issuances_total is not None
        assert registry.authority_mandate_revocations_total is not None
        assert registry.authority_ledger_events_total is not None

    def test_all_gauges_present(self, registry):
        assert registry.gateway_requests_in_flight is not None
        assert registry.database_connection_pool_size is not None
        assert registry.database_connection_pool_checked_out is not None
        assert registry.database_connection_pool_overflow is not None
        assert registry.circuit_breaker_state is not None
        assert registry.merkle_events_in_current_batch is not None
        assert registry.dlq_size is not None
        assert registry.dlq_oldest_message_age_seconds is not None
        assert registry.allowlist_patterns_active is not None
        assert registry.authority_cache_hit_rate is not None


@pytest.mark.unit
class TestGatewayMetrics:
    def test_record_gateway_request(self, registry):
        registry.record_gateway_request("POST", 200, "mtls", 0.05)

    def test_record_gateway_request_error_status(self, registry):
        registry.record_gateway_request("GET", 500, "jwt", 1.2)

    def test_track_gateway_request_in_flight(self, registry):
        with registry.track_gateway_request_in_flight():
            pass

    def test_track_gateway_request_in_flight_on_exception(self, registry):
        with pytest.raises(ValueError):
            with registry.track_gateway_request_in_flight():
                raise ValueError("test")

    def test_record_auth_failure(self, registry):
        registry.record_auth_failure("jwt", "expired_token")
        registry.record_auth_failure("mtls", "cert_invalid")

    def test_record_replay_block(self, registry):
        registry.record_replay_block("duplicate_nonce")

    def test_record_degraded_mode_request(self, registry):
        registry.record_degraded_mode_request()


@pytest.mark.unit
class TestDatabaseMetrics:
    def test_record_database_query_select(self, registry):
        registry.record_database_query(DatabaseOperationType.SELECT, "mandates", "success", 0.01)

    def test_record_database_query_insert(self, registry):
        registry.record_database_query(DatabaseOperationType.INSERT, "ledger_events", "success", 0.02)

    def test_record_database_query_update(self, registry):
        registry.record_database_query(DatabaseOperationType.UPDATE, "principals", "success", 0.005)

    def test_record_database_query_delete(self, registry):
        registry.record_database_query(DatabaseOperationType.DELETE, "sessions", "success", 0.003)

    def test_record_database_query_error(self, registry):
        registry.record_database_query(DatabaseOperationType.SELECT, "mandates", "error", 5.0)

    def test_time_database_query_success(self, registry):
        with registry.time_database_query(DatabaseOperationType.SELECT, "mandates"):
            pass

    def test_time_database_query_records_error_on_exception(self, registry):
        with pytest.raises(RuntimeError):
            with registry.time_database_query(DatabaseOperationType.INSERT, "ledger"):
                raise RuntimeError("db error")

    def test_update_connection_pool_stats(self, registry):
        registry.update_connection_pool_stats(10, 5, 2)
        registry.update_connection_pool_stats(0, 0, 0)

    def test_record_database_connection_error(self, registry):
        registry.record_database_connection_error("timeout")
        registry.record_database_connection_error("connection_refused")


@pytest.mark.unit
class TestCircuitBreakerMetrics:
    def test_set_circuit_breaker_state_closed(self, registry):
        registry.set_circuit_breaker_state("vault", CircuitBreakerState.CLOSED)

    def test_set_circuit_breaker_state_open(self, registry):
        registry.set_circuit_breaker_state("vault", CircuitBreakerState.OPEN)

    def test_set_circuit_breaker_state_half_open(self, registry):
        registry.set_circuit_breaker_state("vault", CircuitBreakerState.HALF_OPEN)

    def test_record_circuit_breaker_failure(self, registry):
        registry.record_circuit_breaker_failure("redis")

    def test_record_circuit_breaker_success(self, registry):
        registry.record_circuit_breaker_success("redis")

    def test_record_circuit_breaker_state_change(self, registry):
        registry.record_circuit_breaker_state_change(
            "vault", CircuitBreakerState.CLOSED, CircuitBreakerState.OPEN
        )
        registry.record_circuit_breaker_state_change(
            "vault", CircuitBreakerState.OPEN, CircuitBreakerState.HALF_OPEN
        )


@pytest.mark.unit
class TestMerkleMetrics:
    def test_record_merkle_batch_created(self, registry):
        registry.record_merkle_batch_created(500, 1.5, 1.2, 0.3)

    def test_time_merkle_tree_computation(self, registry):
        with registry.time_merkle_tree_computation():
            pass

    def test_time_merkle_signing(self, registry):
        with registry.time_merkle_signing():
            pass

    def test_record_merkle_verification_success(self, registry):
        registry.record_merkle_verification(0.001, True)

    def test_record_merkle_verification_failure(self, registry):
        registry.record_merkle_verification(0.002, False, "hash_mismatch")

    def test_time_merkle_verification(self, registry):
        with registry.time_merkle_verification():
            pass

    def test_set_merkle_events_in_current_batch(self, registry):
        registry.set_merkle_events_in_current_batch(42)
        registry.set_merkle_events_in_current_batch(0)


@pytest.mark.unit
class TestSnapshotMetrics:
    def test_record_snapshot_created(self, registry):
        registry.record_snapshot_created("scheduled", 30.0, 1024 * 1024, 10000)

    def test_record_snapshot_recovery(self, registry):
        registry.record_snapshot_recovery(15.5)

    def test_time_snapshot_creation(self, registry):
        with registry.time_snapshot_creation("scheduled"):
            pass


@pytest.mark.unit
class TestAllowlistMetrics:
    def test_record_allowlist_check_allowed(self, registry):
        registry.record_allowlist_check("pid-1", "allowed", "glob", 0.001)

    def test_record_allowlist_check_denied(self, registry):
        registry.record_allowlist_check("pid-1", "denied")

    def test_time_allowlist_check(self, registry):
        with registry.time_allowlist_check("pid-1", "glob"):
            pass

    def test_record_allowlist_cache_hit(self, registry):
        registry.record_allowlist_cache_hit()

    def test_record_allowlist_cache_miss(self, registry):
        registry.record_allowlist_cache_miss()

    def test_set_allowlist_patterns_active(self, registry):
        registry.set_allowlist_patterns_active("pid-1", 10)
        registry.set_allowlist_patterns_active("pid-1", 0)


@pytest.mark.unit
class TestDLQMetrics:
    def test_record_dlq_message(self, registry):
        registry.record_dlq_message("events", "serialization_error")

    def test_update_dlq_size(self, registry):
        registry.update_dlq_size(100)
        registry.update_dlq_size(0)

    def test_update_dlq_oldest_message_age(self, registry):
        registry.update_dlq_oldest_message_age(3600.0)


@pytest.mark.unit
class TestPolicyVersionMetrics:
    def test_record_policy_version_created(self, registry):
        registry.record_policy_version_created("created")
        registry.record_policy_version_created("modified")
        registry.record_policy_version_created("deactivated")

    def test_record_policy_version_query(self, registry):
        registry.record_policy_version_query("history")
        registry.record_policy_version_query("at_time")
        registry.record_policy_version_query("compare")


@pytest.mark.unit
class TestEventReplayMetrics:
    def test_record_event_replay_started(self, registry):
        registry.record_event_replay_started("timestamp")

    def test_record_event_replay_event_processed(self, registry):
        registry.record_event_replay_event_processed("snapshot")

    def test_record_event_replay_completed(self, registry):
        registry.record_event_replay_completed("timestamp", 45.2)

    def test_time_event_replay(self, registry):
        with registry.time_event_replay("snapshot"):
            pass


@pytest.mark.unit
class TestAuthorityMetrics:
    def test_record_authority_mandate_validation_allowed(self, registry):
        registry.record_authority_mandate_validation("pid-1", "allowed", 0.005)

    def test_record_authority_mandate_validation_denied(self, registry):
        registry.record_authority_mandate_validation("pid-1", "denied", 0.003, "expired")

    def test_record_authority_mandate_validation_denied_no_reason(self, registry):
        registry.record_authority_mandate_validation("pid-1", "denied", 0.003)

    def test_time_authority_mandate_validation_allowed(self, registry):
        with registry.time_authority_mandate_validation("pid-1") as result:
            result["decision"] = "allowed"

    def test_time_authority_mandate_validation_denied(self, registry):
        with registry.time_authority_mandate_validation("pid-1") as result:
            result["decision"] = "denied"
            result["denial_reason"] = "expired"

    def test_record_authority_mandate_issuance(self, registry):
        registry.record_authority_mandate_issuance("issuer-1", "subject-1")

    def test_record_authority_mandate_revocation_cascade(self, registry):
        registry.record_authority_mandate_revocation("revoker-1", True)

    def test_record_authority_mandate_revocation_no_cascade(self, registry):
        registry.record_authority_mandate_revocation("revoker-1", False)

    def test_record_authority_ledger_event(self, registry):
        for evt in ("issued", "validated", "denied", "revoked"):
            registry.record_authority_ledger_event(evt)

    def test_update_authority_cache_hit_rate(self, registry):
        registry.update_authority_cache_hit_rate(0.85)
        registry.update_authority_cache_hit_rate(0.0)
        registry.update_authority_cache_hit_rate(1.0)


@pytest.mark.unit
class TestMetricsExport:
    def test_generate_metrics_returns_bytes(self, registry):
        output = registry.generate_metrics()
        assert isinstance(output, bytes)
        assert len(output) > 0

    def test_generate_metrics_contains_known_metric(self, registry):
        registry.record_auth_failure("jwt", "expired")
        output = registry.generate_metrics().decode()
        assert "caracal_gateway_auth_failures_total" in output

    def test_get_content_type(self, registry):
        ct = registry.get_content_type()
        assert "text/plain" in ct or "application/openmetrics" in ct


@pytest.mark.unit
class TestGlobalRegistry:
    def test_initialize_and_get(self):
        r = CollectorRegistry()
        m = initialize_metrics_registry(registry=r)
        assert get_metrics_registry() is m

    def test_get_before_init_raises(self):
        import caracal.monitoring.metrics as mod
        original = mod._metrics_registry
        mod._metrics_registry = None
        try:
            with pytest.raises(RuntimeError, match="not initialized"):
                get_metrics_registry()
        finally:
            mod._metrics_registry = original

    def test_reinitialize_overwrites(self):
        r1 = CollectorRegistry()
        r2 = CollectorRegistry()
        initialize_metrics_registry(registry=r1)
        m2 = initialize_metrics_registry(registry=r2)
        assert get_metrics_registry() is m2
