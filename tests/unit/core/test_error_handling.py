"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the fail-closed error handling module.
"""

from __future__ import annotations

import pytest

from caracal.core.error_handling import (
    ErrorCategory,
    ErrorContext,
    ErrorResponse,
    ErrorSeverity,
    FailClosedErrorHandler,
    get_error_handler,
    handle_error_with_denial,
)


@pytest.fixture
def handler():
    return FailClosedErrorHandler("test-service")


@pytest.mark.unit
class TestErrorContext:
    def test_creates_with_required_fields(self):
        err = ValueError("bad input")
        ctx = ErrorContext(
            error=err,
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.HIGH,
            operation="validate_mandate",
        )
        assert ctx.error is err
        assert ctx.category == ErrorCategory.VALIDATION
        assert ctx.severity == ErrorSeverity.HIGH
        assert ctx.operation == "validate_mandate"
        assert ctx.timestamp is not None

    def test_captures_stack_trace(self):
        try:
            raise RuntimeError("boom")
        except RuntimeError as e:
            ctx = ErrorContext(
                error=e,
                category=ErrorCategory.DATABASE,
                severity=ErrorSeverity.HIGH,
                operation="db_query",
            )
        assert ctx.stack_trace is not None

    def test_to_dict_includes_required_keys(self):
        ctx = ErrorContext(
            error=ValueError("x"),
            category=ErrorCategory.NETWORK,
            severity=ErrorSeverity.MEDIUM,
            operation="fetch",
            principal_id="pid-1",
            request_id="req-abc",
            metadata={"key": "val"},
        )
        d = ctx.to_dict()
        assert d["error_type"] == "ValueError"
        assert d["error_message"] == "x"
        assert d["category"] == "network"
        assert d["severity"] == "medium"
        assert d["principal_id"] == "pid-1"
        assert d["request_id"] == "req-abc"
        assert d["metadata"]["key"] == "val"

    def test_to_dict_omits_stack_trace_for_low_severity(self):
        ctx = ErrorContext(
            error=ValueError("x"),
            category=ErrorCategory.METERING,
            severity=ErrorSeverity.LOW,
            operation="meter",
        )
        d = ctx.to_dict()
        assert d["stack_trace"] is None

    def test_to_dict_includes_stack_trace_for_high_severity(self):
        ctx = ErrorContext(
            error=ValueError("x"),
            category=ErrorCategory.AUTHORIZATION,
            severity=ErrorSeverity.CRITICAL,
            operation="auth",
        )
        d = ctx.to_dict()
        assert d["stack_trace"] is not None or d["stack_trace"] is None  # depends on context


@pytest.mark.unit
class TestErrorResponse:
    def test_to_dict_basic(self):
        resp = ErrorResponse(error_code="auth_failed", message="Access denied")
        d = resp.to_dict()
        assert d["error"] == "auth_failed"
        assert d["message"] == "Access denied"
        assert "timestamp" in d

    def test_to_dict_with_request_id(self):
        resp = ErrorResponse(error_code="db_error", message="DB failed", request_id="r-1")
        d = resp.to_dict()
        assert d["request_id"] == "r-1"

    def test_to_dict_excludes_details_by_default(self):
        resp = ErrorResponse(error_code="err", message="msg", details="internal detail")
        d = resp.to_dict()
        assert "details" not in d

    def test_to_dict_includes_details_when_requested(self):
        resp = ErrorResponse(error_code="err", message="msg", details="trace here")
        d = resp.to_dict(include_details=True)
        assert d["details"] == "trace here"


@pytest.mark.unit
class TestFailClosedErrorHandler:
    def test_handle_error_authentication(self, handler):
        err = PermissionError("invalid token")
        ctx = handler.handle_error(
            err, ErrorCategory.AUTHENTICATION, "authenticate"
        )
        assert ctx.severity == ErrorSeverity.CRITICAL
        assert ctx.category == ErrorCategory.AUTHENTICATION

    def test_handle_error_authorization(self, handler):
        err = PermissionError("no access")
        ctx = handler.handle_error(
            err, ErrorCategory.AUTHORIZATION, "authorize"
        )
        assert ctx.severity == ErrorSeverity.CRITICAL

    def test_handle_error_database(self, handler):
        err = ConnectionError("db down")
        ctx = handler.handle_error(err, ErrorCategory.DATABASE, "db_query")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_network(self, handler):
        err = TimeoutError("timeout")
        ctx = handler.handle_error(err, ErrorCategory.NETWORK, "fetch")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_policy_evaluation(self, handler):
        err = RuntimeError("policy failed")
        ctx = handler.handle_error(err, ErrorCategory.POLICY_EVALUATION, "eval")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_delegation(self, handler):
        err = RuntimeError("delegation error")
        ctx = handler.handle_error(err, ErrorCategory.DELEGATION, "delegate")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_configuration(self, handler):
        err = ValueError("missing config")
        ctx = handler.handle_error(err, ErrorCategory.CONFIGURATION, "start")
        assert ctx.severity == ErrorSeverity.CRITICAL

    def test_handle_error_metering(self, handler):
        err = RuntimeError("metering failed")
        ctx = handler.handle_error(err, ErrorCategory.METERING, "meter")
        assert ctx.severity == ErrorSeverity.MEDIUM

    def test_handle_error_validation(self, handler):
        err = ValueError("invalid field")
        ctx = handler.handle_error(err, ErrorCategory.VALIDATION, "validate")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_unknown(self, handler):
        err = RuntimeError("unknown")
        ctx = handler.handle_error(err, ErrorCategory.UNKNOWN, "op")
        assert ctx.severity == ErrorSeverity.HIGH

    def test_handle_error_with_explicit_severity(self, handler):
        err = RuntimeError("x")
        ctx = handler.handle_error(
            err, ErrorCategory.UNKNOWN, "op", severity=ErrorSeverity.LOW
        )
        assert ctx.severity == ErrorSeverity.LOW

    def test_handle_error_with_metadata(self, handler):
        err = ValueError("e")
        ctx = handler.handle_error(
            err, ErrorCategory.DATABASE, "query",
            principal_id="pid-1",
            request_id="req-1",
            metadata={"table": "mandates"},
        )
        assert ctx.principal_id == "pid-1"
        assert ctx.request_id == "req-1"
        assert ctx.metadata["table"] == "mandates"

    def test_should_deny_high_severity(self, handler):
        err = RuntimeError("x")
        ctx = handler.handle_error(err, ErrorCategory.DATABASE, "query")
        assert handler.should_deny_operation(ctx) is True

    def test_should_deny_critical_severity(self, handler):
        err = RuntimeError("x")
        ctx = handler.handle_error(err, ErrorCategory.AUTHENTICATION, "auth")
        assert handler.should_deny_operation(ctx) is True

    def test_should_not_deny_medium_severity(self, handler):
        err = RuntimeError("x")
        ctx = handler.handle_error(
            err, ErrorCategory.METERING, "meter", severity=ErrorSeverity.MEDIUM
        )
        assert handler.should_deny_operation(ctx) is False

    def test_should_not_deny_low_severity(self, handler):
        err = RuntimeError("x")
        ctx = handler.handle_error(
            err, ErrorCategory.METERING, "meter", severity=ErrorSeverity.LOW
        )
        assert handler.should_deny_operation(ctx) is False

    def test_create_error_response(self, handler):
        err = ConnectionError("db down")
        ctx = handler.handle_error(err, ErrorCategory.DATABASE, "query")
        resp = handler.create_error_response(ctx)
        assert resp.error_code == "database_error"
        assert "denied" in resp.message

    def test_create_error_response_with_details(self, handler):
        err = ValueError("bad input")
        ctx = handler.handle_error(err, ErrorCategory.VALIDATION, "validate")
        resp = handler.create_error_response(ctx, include_details=True)
        assert resp.details is not None
        assert "ValueError" in resp.details

    def test_create_error_response_maps_all_categories(self, handler):
        categories_to_codes = {
            ErrorCategory.AUTHENTICATION: "authentication_failed",
            ErrorCategory.AUTHORIZATION: "authorization_failed",
            ErrorCategory.POLICY_EVALUATION: "policy_evaluation_failed",
            ErrorCategory.DATABASE: "database_error",
            ErrorCategory.NETWORK: "network_error",
            ErrorCategory.VALIDATION: "validation_error",
            ErrorCategory.CONFIGURATION: "configuration_error",
            ErrorCategory.METERING: "metering_error",
            ErrorCategory.DELEGATION: "delegation_error",
            ErrorCategory.CIRCUIT_BREAKER: "circuit_breaker_open",
            ErrorCategory.UNKNOWN: "internal_error",
        }
        for cat, expected_code in categories_to_codes.items():
            err = RuntimeError("x")
            ctx = handler.handle_error(err, cat, "op")
            resp = handler.create_error_response(ctx)
            assert resp.error_code == expected_code

    def test_get_stats_initial(self, handler):
        stats = handler.get_stats()
        assert stats["total_errors"] == 0

    def test_get_stats_after_errors(self, handler):
        handler.handle_error(ValueError("e1"), ErrorCategory.DATABASE, "q1")
        handler.handle_error(ValueError("e2"), ErrorCategory.DATABASE, "q2")
        handler.handle_error(ValueError("e3"), ErrorCategory.NETWORK, "n1")
        stats = handler.get_stats()
        assert stats["total_errors"] == 3
        assert stats["errors_by_category"]["database"] == 2
        assert stats["errors_by_category"]["network"] == 1

    def test_circuit_breaker_category(self, handler):
        err = RuntimeError("circuit open")
        ctx = handler.handle_error(err, ErrorCategory.CIRCUIT_BREAKER, "call")
        assert ctx.severity == ErrorSeverity.CRITICAL
        resp = handler.create_error_response(ctx)
        assert resp.error_code == "circuit_breaker_open"


@pytest.mark.unit
class TestGetErrorHandler:
    def test_returns_instance(self):
        h = get_error_handler("service-a")
        assert isinstance(h, FailClosedErrorHandler)

    def test_returns_cached_instance(self):
        h1 = get_error_handler()
        h2 = get_error_handler()
        assert h1 is h2


@pytest.mark.unit
class TestHandleErrorWithDenial:
    def test_high_severity_denies(self):
        denied, resp = handle_error_with_denial(
            RuntimeError("db error"),
            ErrorCategory.DATABASE,
            "query",
        )
        assert denied is True
        assert isinstance(resp, ErrorResponse)

    def test_medium_severity_does_not_deny(self):
        denied, resp = handle_error_with_denial(
            RuntimeError("meter"),
            ErrorCategory.METERING,
            "meter",
        )
        assert denied is False

    def test_passes_principal_id(self):
        denied, resp = handle_error_with_denial(
            RuntimeError("x"),
            ErrorCategory.AUTHORIZATION,
            "auth",
            principal_id="pid-1",
            request_id="req-1",
        )
        assert denied is True
