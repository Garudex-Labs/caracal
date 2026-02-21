"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Fail-closed error handling for Caracal Core v0.2.

Provides centralized error handling with fail-closed semantics:
- All uncertain states result in denial of access
- Comprehensive error logging with structured context
- Standardized error response formatting

"""

import logging
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, Any
from uuid import UUID

from caracal.exceptions import CaracalError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class ErrorSeverity(Enum):
    """Error severity levels for fail-closed handling."""
    LOW = "low"  # Non-critical errors, operation can continue
    MEDIUM = "medium"  # Errors that should be logged but may not block operations
    HIGH = "high"  # Critical errors that must block operations (fail-closed)
    CRITICAL = "critical"  # System-level errors requiring immediate attention


class ErrorCategory(Enum):
    """Categories of errors for structured logging and metrics."""
    AUTHENTICATION = "authentication"
    AUTHORIZATION = "authorization"
    POLICY_EVALUATION = "policy_evaluation"
    DATABASE = "database"
    NETWORK = "network"
    VALIDATION = "validation"
    CONFIGURATION = "configuration"
    METERING = "metering"
    DELEGATION = "delegation"
    CIRCUIT_BREAKER = "circuit_breaker"
    UNKNOWN = "unknown"


@dataclass
class ErrorContext:
    """
    Structured error context for comprehensive logging.
    
    Attributes:
        error: The exception that occurred
        category: Error category for classification
        severity: Error severity level
        operation: Name of the operation that failed
        agent_id: Optional agent ID involved in the error
        request_id: Optional request/correlation ID
        metadata: Additional context-specific metadata
        timestamp: When the error occurred
        stack_trace: Full stack trace for debugging
    """
    error: Exception
    category: ErrorCategory
    severity: ErrorSeverity
    operation: str
    agent_id: Optional[str] = None
    request_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)
    stack_trace: Optional[str] = None
    
    def __post_init__(self):
        """Capture stack trace if not provided."""
        if self.stack_trace is None:
            self.stack_trace = traceback.format_exc()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert error context to dictionary for structured logging."""
        return {
            "error_type": type(self.error).__name__,
            "error_message": str(self.error),
            "category": self.category.value,
            "severity": self.severity.value,
            "operation": self.operation,
            "agent_id": self.agent_id,
            "request_id": self.request_id,
            "metadata": self.metadata,
            "timestamp": self.timestamp.isoformat(),
            "stack_trace": self.stack_trace if self.severity in [ErrorSeverity.HIGH, ErrorSeverity.CRITICAL] else None
        }


@dataclass
class ErrorResponse:
    """
    Standardized error response format.
    
    Provides consistent error responses across all Caracal components
    with appropriate detail levels for different audiences.
    
    Attributes:
        error_code: Machine-readable error code
        message: Human-readable error message
        details: Optional additional details (not exposed to end users)
        request_id: Optional request/correlation ID for tracing
        timestamp: When the error occurred
    """
    error_code: str
    message: str
    details: Optional[str] = None
    request_id: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.utcnow)
    
    def to_dict(self, include_details: bool = False) -> Dict[str, Any]:
        """
        Convert error response to dictionary.
        
        Args:
            include_details: Whether to include detailed error information
                           (should be False for production external APIs)
        
        Returns:
            Dictionary representation of error response
        """
        response = {
            "error": self.error_code,
            "message": self.message,
            "timestamp": self.timestamp.isoformat()
        }
        
        if self.request_id:
            response["request_id"] = self.request_id
        
        if include_details and self.details:
            response["details"] = self.details
        
        return response


class FailClosedErrorHandler:
    """
    Centralized error handler with fail-closed semantics.
    
    Ensures that all error paths result in denial of operations,
    with comprehensive logging and standardized error responses.
    
    """
    
    def __init__(self, service_name: str = "caracal-core"):
        """
        Initialize error handler.
        
        Args:
            service_name: Name of the service for logging context
        """
        self.service_name = service_name
        self._error_count = 0
        self._error_count_by_category: Dict[ErrorCategory, int] = {}
    
    def handle_error(
        self,
        error: Exception,
        category: ErrorCategory,
        operation: str,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        severity: Optional[ErrorSeverity] = None
    ) -> ErrorContext:
        """
        Handle an error with fail-closed semantics.
        
        This method:
        1. Determines error severity if not provided
        2. Creates structured error context
        3. Logs error with appropriate level
        4. Updates error metrics
        5. Returns error context for further processing
        
        Args:
            error: The exception that occurred
            category: Error category for classification
            operation: Name of the operation that failed
            agent_id: Optional agent ID involved in the error
            request_id: Optional request/correlation ID
            metadata: Optional additional context
            severity: Optional severity override (auto-determined if not provided)
        
        Returns:
            ErrorContext with structured error information
        """
        # Auto-determine severity if not provided
        if severity is None:
            severity = self._determine_severity(error, category)
        
        # Create error context
        context = ErrorContext(
            error=error,
            category=category,
            severity=severity,
            operation=operation,
            agent_id=agent_id,
            request_id=request_id,
            metadata=metadata or {}
        )
        
        # Log error with appropriate level
        self._log_error(context)
        
        # Update metrics
        self._update_metrics(context)
        
        return context
    
    def _determine_severity(self, error: Exception, category: ErrorCategory) -> ErrorSeverity:
        """
        Determine error severity based on error type and category.
        
        Fail-closed principle: When in doubt, treat as HIGH severity.
        
        Args:
            error: The exception that occurred
            category: Error category
        
        Returns:
            ErrorSeverity level
        """
        # Critical categories that always fail closed
        critical_categories = {
            ErrorCategory.AUTHENTICATION,
            ErrorCategory.AUTHORIZATION,
            ErrorCategory.CIRCUIT_BREAKER
        }
        
        if category in critical_categories:
            return ErrorSeverity.CRITICAL
        
        # Database errors are high severity (fail closed)
        if category == ErrorCategory.DATABASE:
            return ErrorSeverity.HIGH
        
        # Policy evaluation errors are high severity (fail closed)
        if category == ErrorCategory.POLICY_EVALUATION:
            return ErrorSeverity.HIGH
        
        # Delegation token errors are high severity (fail closed)
        if category == ErrorCategory.DELEGATION:
            return ErrorSeverity.HIGH
        
        # Configuration errors are critical (system cannot function)
        if category == ErrorCategory.CONFIGURATION:
            return ErrorSeverity.CRITICAL
        
        # Metering errors are medium (log but don't block operations)
        # Provisional charges will be cleaned up by background job
        if category == ErrorCategory.METERING:
            return ErrorSeverity.MEDIUM
        
        # Network errors are high severity (fail closed)
        if category == ErrorCategory.NETWORK:
            return ErrorSeverity.HIGH
        
        # Validation errors are high severity (fail closed)
        if category == ErrorCategory.VALIDATION:
            return ErrorSeverity.HIGH
        
        # Unknown errors are high severity (fail closed)
        return ErrorSeverity.HIGH
    
    def _log_error(self, context: ErrorContext) -> None:
        """
        Log error with appropriate level and structured context.
        
        Args:
            context: ErrorContext with error information
        """
        log_data = context.to_dict()
        log_data["service"] = self.service_name
        
        # Log with appropriate level based on severity
        if context.severity == ErrorSeverity.CRITICAL:
            logger.critical(
                f"CRITICAL ERROR in {context.operation}: {context.error}",
                extra=log_data,
                exc_info=context.error
            )
        elif context.severity == ErrorSeverity.HIGH:
            logger.error(
                f"HIGH SEVERITY ERROR in {context.operation}: {context.error}",
                extra=log_data,
                exc_info=context.error
            )
        elif context.severity == ErrorSeverity.MEDIUM:
            logger.warning(
                f"MEDIUM SEVERITY ERROR in {context.operation}: {context.error}",
                extra=log_data
            )
        else:  # LOW
            logger.info(
                f"LOW SEVERITY ERROR in {context.operation}: {context.error}",
                extra=log_data
            )
    
    def _update_metrics(self, context: ErrorContext) -> None:
        """
        Update error metrics.
        
        Args:
            context: ErrorContext with error information
        """
        self._error_count += 1
        
        if context.category not in self._error_count_by_category:
            self._error_count_by_category[context.category] = 0
        self._error_count_by_category[context.category] += 1
    
    def create_error_response(
        self,
        context: ErrorContext,
        include_details: bool = False
    ) -> ErrorResponse:
        """
        Create standardized error response from error context.
        
        Args:
            context: ErrorContext with error information
            include_details: Whether to include detailed error information
        
        Returns:
            ErrorResponse with standardized format
        """
        # Map error categories to error codes
        error_code_map = {
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
            ErrorCategory.UNKNOWN: "internal_error"
        }
        
        error_code = error_code_map.get(context.category, "internal_error")
        
        # Create user-friendly message based on severity
        if context.severity in [ErrorSeverity.HIGH, ErrorSeverity.CRITICAL]:
            # Fail-closed message
            message = f"Operation denied due to {context.category.value} error (fail-closed)"
        else:
            # Non-blocking error message
            message = f"Operation completed with {context.category.value} error"
        
        # Include technical details if requested
        details = None
        if include_details:
            details = f"{type(context.error).__name__}: {str(context.error)}"
        
        return ErrorResponse(
            error_code=error_code,
            message=message,
            details=details,
            request_id=context.request_id,
            timestamp=context.timestamp
        )
    
    def should_deny_operation(self, context: ErrorContext) -> bool:
        """
        Determine if operation should be denied based on error context.
        
        Fail-closed principle: HIGH and CRITICAL severity errors always deny.
        
        Args:
            context: ErrorContext with error information
        
        Returns:
            True if operation should be denied, False otherwise
        """
        return context.severity in [ErrorSeverity.HIGH, ErrorSeverity.CRITICAL]
    
    def get_stats(self) -> Dict[str, Any]:
        """
        Get error handler statistics.
        
        Returns:
            Dictionary with error statistics
        """
        return {
            "total_errors": self._error_count,
            "errors_by_category": {
                category.value: count
                for category, count in self._error_count_by_category.items()
            }
        }


# Global error handler instance
_error_handler: Optional[FailClosedErrorHandler] = None


def get_error_handler(service_name: str = "caracal-core") -> FailClosedErrorHandler:
    """
    Get or create global error handler instance.
    
    Args:
        service_name: Name of the service for logging context
    
    Returns:
        FailClosedErrorHandler instance
    """
    global _error_handler
    if _error_handler is None:
        _error_handler = FailClosedErrorHandler(service_name)
    return _error_handler


def handle_error_with_denial(
    error: Exception,
    category: ErrorCategory,
    operation: str,
    agent_id: Optional[str] = None,
    request_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> tuple[bool, ErrorResponse]:
    """
    Convenience function to handle error and determine if operation should be denied.
    
    This function implements fail-closed semantics:
    - HIGH and CRITICAL severity errors result in denial
    - Error is logged with comprehensive context
    - Standardized error response is returned
    
    Args:
        error: The exception that occurred
        category: Error category for classification
        operation: Name of the operation that failed
        agent_id: Optional agent ID involved in the error
        request_id: Optional request/correlation ID
        metadata: Optional additional context
    
    Returns:
        Tuple of (should_deny, error_response)
        - should_deny: True if operation should be denied
        - error_response: Standardized error response
    
    """
    handler = get_error_handler()
    context = handler.handle_error(
        error=error,
        category=category,
        operation=operation,
        agent_id=agent_id,
        request_id=request_id,
        metadata=metadata
    )
    
    should_deny = handler.should_deny_operation(context)
    error_response = handler.create_error_response(context, include_details=False)
    
    return should_deny, error_response
