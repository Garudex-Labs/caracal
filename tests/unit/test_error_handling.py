"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for fail-closed error handling.

Tests the error handling module to ensure all error paths
result in denial of operations with comprehensive logging.

"""

import pytest
from datetime import datetime
from decimal import Decimal

from caracal.core.error_handling import (
    FailClosedErrorHandler,
    ErrorCategory,
    ErrorSeverity,
    ErrorContext,
    ErrorResponse,
    get_error_handler,
    handle_error_with_denial
)
from caracal.exceptions import (
    PolicyEvaluationError,
    TokenValidationError,
    AgentNotFoundError
)


class TestErrorContext:
    """Test ErrorContext dataclass."""
    
    def test_error_context_creation(self):
        """Test creating error context with all fields."""
        error = ValueError("Test error")
        context = ErrorContext(
            error=error,
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.HIGH,
            operation="test_operation",
            agent_id="test-agent-123",
            request_id="req-456",
            metadata={"key": "value"}
        )
        
        assert context.error == error
        assert context.category == ErrorCategory.VALIDATION
        assert context.severity == ErrorSeverity.HIGH
        assert context.operation == "test_operation"
        assert context.agent_id == "test-agent-123"
        assert context.request_id == "req-456"
        assert context.metadata == {"key": "value"}
        assert context.timestamp is not None
        assert context.stack_trace is not None
    
    def test_error_context_to_dict(self):
        """Test converting error context to dictionary."""
        error = ValueError("Test error")
        context = ErrorContext(
            error=error,
            category=ErrorCategory.AUTHENTICATION,
            severity=ErrorSeverity.CRITICAL,
            operation="authenticate",
            agent_id="agent-123"
        )
        
        data = context.to_dict()
        
        assert data["error_type"] == "ValueError"
        assert data["error_message"] == "Test error"
        assert data["category"] == "authentication"
        assert data["severity"] == "critical"
        assert data["operation"] == "authenticate"
        assert data["agent_id"] == "agent-123"
        assert "timestamp" in data
        assert "stack_trace" in data  # Included for CRITICAL severity


class TestErrorResponse:
    """Test ErrorResponse dataclass."""
    
    def test_error_response_creation(self):
        """Test creating error response."""
        response = ErrorResponse(
            error_code="authentication_failed",
            message="Authentication failed",
            details="Invalid credentials",
            request_id="req-123"
        )
        
        assert response.error_code == "authentication_failed"
        assert response.message == "Authentication failed"
        assert response.details == "Invalid credentials"
        assert response.request_id == "req-123"
        assert response.timestamp is not None
    
    def test_error_response_to_dict_without_details(self):
        """Test converting error response to dict without details."""
        response = ErrorResponse(
            error_code="policy_evaluation_failed",
            message="Policy evaluation failed",
            details="Database connection error",
            request_id="req-456"
        )
        
        data = response.to_dict(include_details=False)
        
        assert data["error"] == "policy_evaluation_failed"
        assert data["message"] == "Policy evaluation failed"
        assert data["request_id"] == "req-456"
        assert "details" not in data  # Should not be included
        assert "timestamp" in data
    
    def test_error_response_to_dict_with_details(self):
        """Test converting error response to dict with details."""
        response = ErrorResponse(
            error_code="database_error",
            message="Database error",
            details="Connection timeout",
            request_id="req-789"
        )
        
        data = response.to_dict(include_details=True)
        
        assert data["error"] == "database_error"
        assert data["message"] == "Database error"
        assert data["details"] == "Connection timeout"
        assert data["request_id"] == "req-789"


class TestFailClosedErrorHandler:
    """Test FailClosedErrorHandler class."""
    
    def test_handler_initialization(self):
        """Test initializing error handler."""
        handler = FailClosedErrorHandler(service_name="test-service")
        
        assert handler.service_name == "test-service"
        assert handler._error_count == 0
        assert len(handler._error_count_by_category) == 0
    
    def test_determine_severity_authentication(self):
        """Test severity determination for authentication errors."""
        handler = FailClosedErrorHandler()
        error = Exception("Auth failed")
        
        severity = handler._determine_severity(error, ErrorCategory.AUTHENTICATION)
        
        assert severity == ErrorSeverity.CRITICAL
    
    def test_determine_severity_policy_evaluation(self):
        """Test severity determination for policy evaluation errors."""
        handler = FailClosedErrorHandler()
        error = PolicyEvaluationError("Policy check failed")
        
        severity = handler._determine_severity(error, ErrorCategory.POLICY_EVALUATION)
        
        assert severity == ErrorSeverity.HIGH
    
    def test_determine_severity_metering(self):
        """Test severity determination for metering errors."""
        handler = FailClosedErrorHandler()
        error = Exception("Metering failed")
        
        severity = handler._determine_severity(error, ErrorCategory.METERING)
        
        assert severity == ErrorSeverity.MEDIUM
    
    def test_handle_error(self):
        """Test handling an error."""
        handler = FailClosedErrorHandler(service_name="test-service")
        error = ValueError("Test error")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.VALIDATION,
            operation="validate_input",
            agent_id="agent-123",
            request_id="req-456",
            metadata={"input": "invalid"}
        )
        
        assert context.error == error
        assert context.category == ErrorCategory.VALIDATION
        assert context.severity == ErrorSeverity.HIGH  # Auto-determined
        assert context.operation == "validate_input"
        assert context.agent_id == "agent-123"
        assert context.request_id == "req-456"
        assert handler._error_count == 1
        assert handler._error_count_by_category[ErrorCategory.VALIDATION] == 1
    
    def test_should_deny_operation_high_severity(self):
        """Test that HIGH severity errors result in denial."""
        handler = FailClosedErrorHandler()
        error = PolicyEvaluationError("Policy failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.POLICY_EVALUATION,
            operation="evaluate_policy"
        )
        
        assert handler.should_deny_operation(context) is True
    
    def test_should_deny_operation_critical_severity(self):
        """Test that CRITICAL severity errors result in denial."""
        handler = FailClosedErrorHandler()
        error = Exception("Auth failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.AUTHENTICATION,
            operation="authenticate"
        )
        
        assert handler.should_deny_operation(context) is True
    
    def test_should_deny_operation_medium_severity(self):
        """Test that MEDIUM severity errors do not result in denial."""
        handler = FailClosedErrorHandler()
        error = Exception("Metering failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.METERING,
            operation="collect_event"
        )
        
        assert handler.should_deny_operation(context) is False
    
    def test_create_error_response(self):
        """Test creating error response from context."""
        handler = FailClosedErrorHandler()
        error = TokenValidationError("Invalid token")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.DELEGATION,
            operation="validate_token",
            agent_id="agent-123"
        )
        
        response = handler.create_error_response(context, include_details=False)
        
        assert response.error_code == "delegation_error"
        assert "fail-closed" in response.message.lower()
        assert response.details is None
    
    def test_create_error_response_with_details(self):
        """Test creating error response with details."""
        handler = FailClosedErrorHandler()
        error = AgentNotFoundError("Agent not found")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.VALIDATION,
            operation="get_agent"
        )
        
        response = handler.create_error_response(context, include_details=True)
        
        assert response.error_code == "validation_error"
        assert response.details is not None
        assert "AgentNotFoundError" in response.details
    
    def test_get_stats(self):
        """Test getting error statistics."""
        handler = FailClosedErrorHandler()
        
        # Handle multiple errors
        handler.handle_error(
            error=Exception("Error 1"),
            category=ErrorCategory.AUTHENTICATION,
            operation="op1"
        )
        handler.handle_error(
            error=Exception("Error 2"),
            category=ErrorCategory.AUTHENTICATION,
            operation="op2"
        )
        handler.handle_error(
            error=Exception("Error 3"),
            category=ErrorCategory.POLICY_EVALUATION,
            operation="op3"
        )
        
        stats = handler.get_stats()
        
        assert stats["total_errors"] == 3
        assert stats["errors_by_category"]["authentication"] == 2
        assert stats["errors_by_category"]["policy_evaluation"] == 1


class TestConvenienceFunctions:
    """Test convenience functions."""
    
    def test_get_error_handler(self):
        """Test getting global error handler."""
        handler1 = get_error_handler("service1")
        handler2 = get_error_handler("service2")
        
        # Should return the same instance (singleton)
        assert handler1 is handler2
    
    def test_handle_error_with_denial_high_severity(self):
        """Test convenience function with HIGH severity error."""
        error = PolicyEvaluationError("Policy failed")
        
        should_deny, error_response = handle_error_with_denial(
            error=error,
            category=ErrorCategory.POLICY_EVALUATION,
            operation="evaluate_policy",
            agent_id="agent-123"
        )
        
        assert should_deny is True
        assert error_response.error_code == "policy_evaluation_failed"
        assert "fail-closed" in error_response.message.lower()
    
    def test_handle_error_with_denial_medium_severity(self):
        """Test convenience function with MEDIUM severity error."""
        error = Exception("Metering failed")
        
        should_deny, error_response = handle_error_with_denial(
            error=error,
            category=ErrorCategory.METERING,
            operation="collect_event"
        )
        
        assert should_deny is False
        assert error_response.error_code == "metering_error"


class TestFailClosedSemantics:
    """Test fail-closed semantics across different error categories."""
    
    def test_authentication_errors_fail_closed(self):
        """Test that authentication errors always fail closed."""
        handler = FailClosedErrorHandler()
        error = Exception("Auth failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.AUTHENTICATION,
            operation="authenticate"
        )
        
        assert context.severity == ErrorSeverity.CRITICAL
        assert handler.should_deny_operation(context) is True
    
    def test_authorization_errors_fail_closed(self):
        """Test that authorization errors always fail closed."""
        handler = FailClosedErrorHandler()
        error = Exception("Replay detected")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.AUTHORIZATION,
            operation="check_replay"
        )
        
        assert context.severity == ErrorSeverity.CRITICAL
        assert handler.should_deny_operation(context) is True
    
    def test_policy_evaluation_errors_fail_closed(self):
        """Test that policy evaluation errors fail closed."""
        handler = FailClosedErrorHandler()
        error = PolicyEvaluationError("Policy service unavailable")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.POLICY_EVALUATION,
            operation="evaluate_policy"
        )
        
        assert context.severity == ErrorSeverity.HIGH
        assert handler.should_deny_operation(context) is True
    
    def test_database_errors_fail_closed(self):
        """Test that database errors fail closed."""
        handler = FailClosedErrorHandler()
        error = Exception("Database connection failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.DATABASE,
            operation="query_policies"
        )
        
        assert context.severity == ErrorSeverity.HIGH
        assert handler.should_deny_operation(context) is True
    
    def test_delegation_errors_fail_closed(self):
        """Test that delegation token errors fail closed."""
        handler = FailClosedErrorHandler()
        error = TokenValidationError("Invalid token")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.DELEGATION,
            operation="validate_token"
        )
        
        assert context.severity == ErrorSeverity.HIGH
        assert handler.should_deny_operation(context) is True
    
    def test_unknown_errors_fail_closed(self):
        """Test that unknown errors fail closed."""
        handler = FailClosedErrorHandler()
        error = Exception("Unknown error")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.UNKNOWN,
            operation="unknown_operation"
        )
        
        assert context.severity == ErrorSeverity.HIGH
        assert handler.should_deny_operation(context) is True
    
    def test_metering_errors_do_not_fail_closed(self):
        """Test that metering errors do not fail closed (MEDIUM severity)."""
        handler = FailClosedErrorHandler()
        error = Exception("Metering failed")
        
        context = handler.handle_error(
            error=error,
            category=ErrorCategory.METERING,
            operation="collect_event"
        )
        
        assert context.severity == ErrorSeverity.MEDIUM
        assert handler.should_deny_operation(context) is False
