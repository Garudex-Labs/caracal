"""
Logging configuration for Caracal Core.

Provides centralized structured logging setup with JSON output for production
and human-readable output for development. Supports correlation IDs for
request tracing across components.
"""

import logging
import sys
import uuid
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, Optional

import structlog
from structlog.types import EventDict, Processor


# Context variable for correlation ID
correlation_id_var: ContextVar[Optional[str]] = ContextVar("correlation_id", default=None)


def add_correlation_id(logger: Any, method_name: str, event_dict: EventDict) -> EventDict:
    """
    Add correlation ID to log events if present in context.
    
    Args:
        logger: Logger instance
        method_name: Name of the logging method
        event_dict: Event dictionary to modify
        
    Returns:
        Modified event dictionary with correlation_id if available
    """
    correlation_id = correlation_id_var.get()
    if correlation_id:
        event_dict["correlation_id"] = correlation_id
    return event_dict


def set_correlation_id(correlation_id: Optional[str] = None) -> str:
    """
    Set correlation ID for the current context.
    
    Args:
        correlation_id: Optional correlation ID. If None, generates a new UUID.
        
    Returns:
        The correlation ID that was set
    """
    if correlation_id is None:
        correlation_id = str(uuid.uuid4())
    correlation_id_var.set(correlation_id)
    return correlation_id


def clear_correlation_id() -> None:
    """Clear correlation ID from the current context."""
    correlation_id_var.set(None)


def get_correlation_id() -> Optional[str]:
    """
    Get the current correlation ID from context.
    
    Returns:
        Current correlation ID or None if not set
    """
    return correlation_id_var.get()


def setup_logging(
    level: str = "INFO",
    log_file: Optional[Path] = None,
    json_format: bool = True,
) -> None:
    """
    Configure structured logging for Caracal Core.
    
    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        log_file: Optional path to log file. If None, logs only to stdout.
        json_format: If True, use JSON format. If False, use human-readable format.
    """
    # Convert string level to logging constant
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    
    # Get root logger and set level
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    
    # Clear existing handlers to avoid duplicates
    root_logger.handlers.clear()
    
    # Configure file handler if specified
    if log_file is not None:
        log_file = Path(log_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(numeric_level)
        file_handler.setFormatter(logging.Formatter("%(message)s"))
        root_logger.addHandler(file_handler)
    else:
        # Add stderr handler if no file specified
        stderr_handler = logging.StreamHandler(sys.stderr)
        stderr_handler.setLevel(numeric_level)
        stderr_handler.setFormatter(logging.Formatter("%(message)s"))
        root_logger.addHandler(stderr_handler)
    
    # Build processor chain
    processors: list = [
        # Add log level
        structlog.stdlib.add_log_level,
        # Add logger name
        structlog.stdlib.add_logger_name,
        # Add timestamp
        structlog.processors.TimeStamper(fmt="iso"),
        # Add correlation ID if present
        add_correlation_id,
        # Add stack info for exceptions
        structlog.processors.StackInfoRenderer(),
        # Format exceptions
        structlog.processors.format_exc_info,
    ]
    
    # Add appropriate renderer based on format
    if json_format:
        # JSON format for production
        processors.append(structlog.processors.JSONRenderer())
    else:
        # Human-readable format for development
        processors.extend([
            structlog.dev.ConsoleRenderer(colors=True),
        ])
    
    # Configure structlog
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """
    Get a structured logger instance for a specific module.
    
    Args:
        name: Logger name (typically __name__ of the module).
        
    Returns:
        Structured logger instance.
    """
    return structlog.get_logger(f"caracal.{name}")


# Convenience functions for common logging patterns

def log_budget_decision(
    logger: structlog.stdlib.BoundLogger,
    agent_id: str,
    decision: str,
    remaining_budget: Optional[str] = None,
    provisional_charge_id: Optional[str] = None,
    reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a budget check decision.
    
    Args:
        logger: Logger instance
        agent_id: Agent ID
        decision: Decision outcome ("allow" or "deny")
        remaining_budget: Remaining budget after decision
        provisional_charge_id: ID of provisional charge if created
        reason: Reason for the decision
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "budget_check_decision",
        "agent_id": agent_id,
        "decision": decision,
    }
    
    if remaining_budget is not None:
        log_data["remaining_budget"] = remaining_budget
    if provisional_charge_id is not None:
        log_data["provisional_charge_id"] = provisional_charge_id
    if reason is not None:
        log_data["reason"] = reason
    
    log_data.update(kwargs)
    
    if decision == "allow":
        logger.info("budget_check_decision", **log_data)
    else:
        logger.warning("budget_check_decision", **log_data)


def log_authentication_failure(
    logger: structlog.stdlib.BoundLogger,
    auth_method: str,
    agent_id: Optional[str] = None,
    reason: str = "unknown",
    **kwargs: Any,
) -> None:
    """
    Log an authentication failure.
    
    Args:
        logger: Logger instance
        auth_method: Authentication method used ("mtls", "jwt", "api_key")
        agent_id: Agent ID if available
        reason: Reason for failure
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "authentication_failure",
        "auth_method": auth_method,
        "reason": reason,
    }
    
    if agent_id is not None:
        log_data["agent_id"] = agent_id
    
    log_data.update(kwargs)
    
    logger.warning("authentication_failure", **log_data)


def log_database_query(
    logger: structlog.stdlib.BoundLogger,
    operation: str,
    table: str,
    duration_ms: float,
    **kwargs: Any,
) -> None:
    """
    Log a database query for performance monitoring.
    
    Args:
        logger: Logger instance
        operation: Database operation ("select", "insert", "update", "delete")
        table: Table name
        duration_ms: Query duration in milliseconds
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "database_query",
        "operation": operation,
        "table": table,
        "duration_ms": duration_ms,
    }
    
    log_data.update(kwargs)
    
    logger.debug("database_query", **log_data)


def log_delegation_token_validation(
    logger: structlog.stdlib.BoundLogger,
    parent_agent_id: str,
    child_agent_id: str,
    success: bool,
    reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a delegation token validation.
    
    Args:
        logger: Logger instance
        parent_agent_id: Parent agent ID
        child_agent_id: Child agent ID
        success: Whether validation succeeded
        reason: Reason for failure if not successful
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "delegation_token_validation",
        "parent_agent_id": parent_agent_id,
        "child_agent_id": child_agent_id,
        "success": success,
    }
    
    if reason is not None:
        log_data["reason"] = reason
    
    log_data.update(kwargs)
    
    if success:
        logger.info("delegation_token_validation", **log_data)
    else:
        logger.warning("delegation_token_validation", **log_data)

