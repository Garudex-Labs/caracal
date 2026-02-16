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


# v0.3 Structured Logging Functions

def log_merkle_root_computation(
    logger: structlog.stdlib.BoundLogger,
    batch_id: str,
    event_count: int,
    merkle_root: str,
    duration_ms: float,
    **kwargs: Any,
) -> None:
    """
    Log a Merkle root computation.
    
    Args:
        logger: Logger instance
        batch_id: Batch ID
        event_count: Number of events in batch
        merkle_root: Computed Merkle root (hex encoded)
        duration_ms: Computation duration in milliseconds
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "merkle_root_computation",
        "batch_id": batch_id,
        "event_count": event_count,
        "merkle_root": merkle_root,
        "duration_ms": duration_ms,
    }
    
    log_data.update(kwargs)
    
    logger.info("merkle_root_computation", **log_data)


def log_merkle_signature(
    logger: structlog.stdlib.BoundLogger,
    batch_id: str,
    merkle_root: str,
    signature: str,
    signing_backend: str,
    duration_ms: float,
    **kwargs: Any,
) -> None:
    """
    Log a Merkle root signature.
    
    Args:
        logger: Logger instance
        batch_id: Batch ID
        merkle_root: Merkle root that was signed (hex encoded)
        signature: Signature (hex encoded)
        signing_backend: Backend used for signing (software, hsm)
        duration_ms: Signing duration in milliseconds
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "merkle_signature",
        "batch_id": batch_id,
        "merkle_root": merkle_root,
        "signature": signature,
        "signing_backend": signing_backend,
        "duration_ms": duration_ms,
    }
    
    log_data.update(kwargs)
    
    logger.info("merkle_signature", **log_data)


def log_merkle_verification(
    logger: structlog.stdlib.BoundLogger,
    batch_id: str,
    success: bool,
    duration_ms: float,
    failure_reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a Merkle verification operation.
    
    Args:
        logger: Logger instance
        batch_id: Batch ID
        success: Whether verification succeeded
        duration_ms: Verification duration in milliseconds
        failure_reason: Reason for failure if not successful
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "merkle_verification",
        "batch_id": batch_id,
        "success": success,
        "duration_ms": duration_ms,
    }
    
    if failure_reason is not None:
        log_data["failure_reason"] = failure_reason
    
    log_data.update(kwargs)
    
    if success:
        logger.info("merkle_verification", **log_data)
    else:
        logger.error("merkle_verification_failed", **log_data)


def log_policy_version_change(
    logger: structlog.stdlib.BoundLogger,
    policy_id: str,
    agent_id: str,
    change_type: str,
    version_number: int,
    changed_by: str,
    change_reason: str,
    before_values: Optional[Dict[str, Any]] = None,
    after_values: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
) -> None:
    """
    Log a policy version change.
    
    Args:
        logger: Logger instance
        policy_id: Policy ID
        agent_id: Agent ID
        change_type: Type of change (created, modified, deactivated)
        version_number: New version number
        changed_by: Identity of who made the change
        change_reason: Reason for the change
        before_values: Policy values before change
        after_values: Policy values after change
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "policy_version_change",
        "policy_id": policy_id,
        "agent_id": agent_id,
        "change_type": change_type,
        "version_number": version_number,
        "changed_by": changed_by,
        "change_reason": change_reason,
    }
    
    if before_values is not None:
        log_data["before_values"] = before_values
    if after_values is not None:
        log_data["after_values"] = after_values
    
    log_data.update(kwargs)
    
    logger.info("policy_version_change", **log_data)


def log_allowlist_check(
    logger: structlog.stdlib.BoundLogger,
    agent_id: str,
    resource: str,
    result: str,
    matched_pattern: Optional[str] = None,
    pattern_type: Optional[str] = None,
    duration_ms: Optional[float] = None,
    **kwargs: Any,
) -> None:
    """
    Log an allowlist check.
    
    Args:
        logger: Logger instance
        agent_id: Agent ID
        resource: Resource being checked
        result: Check result (allowed, denied, no_allowlist)
        matched_pattern: Pattern that matched (if allowed)
        pattern_type: Type of pattern (regex, glob)
        duration_ms: Check duration in milliseconds
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "allowlist_check",
        "agent_id": agent_id,
        "resource": resource,
        "result": result,
    }
    
    if matched_pattern is not None:
        log_data["matched_pattern"] = matched_pattern
    if pattern_type is not None:
        log_data["pattern_type"] = pattern_type
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    
    log_data.update(kwargs)
    
    if result == "allowed":
        logger.info("allowlist_check", **log_data)
    elif result == "denied":
        logger.warning("allowlist_check_denied", **log_data)
    else:
        logger.debug("allowlist_check", **log_data)


def log_event_replay(
    logger: structlog.stdlib.BoundLogger,
    replay_id: str,
    source: str,
    start_offset: Optional[int] = None,
    start_timestamp: Optional[str] = None,
    events_processed: Optional[int] = None,
    duration_seconds: Optional[float] = None,
    status: str = "started",
    **kwargs: Any,
) -> None:
    """
    Log an event replay operation.
    
    Args:
        logger: Logger instance
        replay_id: Unique replay operation ID
        source: Replay source (timestamp, snapshot, offset)
        start_offset: Starting Kafka offset (if applicable)
        start_timestamp: Starting timestamp (if applicable)
        events_processed: Number of events processed (if completed)
        duration_seconds: Replay duration in seconds (if completed)
        status: Replay status (started, in_progress, completed, failed)
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "event_replay",
        "replay_id": replay_id,
        "source": source,
        "status": status,
    }
    
    if start_offset is not None:
        log_data["start_offset"] = start_offset
    if start_timestamp is not None:
        log_data["start_timestamp"] = start_timestamp
    if events_processed is not None:
        log_data["events_processed"] = events_processed
    if duration_seconds is not None:
        log_data["duration_seconds"] = duration_seconds
    
    log_data.update(kwargs)
    
    if status == "started":
        logger.info("event_replay_started", **log_data)
    elif status == "completed":
        logger.info("event_replay_completed", **log_data)
    elif status == "failed":
        logger.error("event_replay_failed", **log_data)
    else:
        logger.debug("event_replay_progress", **log_data)


def log_snapshot_operation(
    logger: structlog.stdlib.BoundLogger,
    snapshot_id: str,
    operation: str,
    trigger: Optional[str] = None,
    event_count: Optional[int] = None,
    size_bytes: Optional[int] = None,
    duration_seconds: Optional[float] = None,
    status: str = "started",
    **kwargs: Any,
) -> None:
    """
    Log a snapshot operation.
    
    Args:
        logger: Logger instance
        snapshot_id: Snapshot ID
        operation: Operation type (create, restore, delete)
        trigger: What triggered the operation (scheduled, manual, recovery)
        event_count: Number of events in snapshot
        size_bytes: Snapshot size in bytes
        duration_seconds: Operation duration in seconds
        status: Operation status (started, completed, failed)
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "snapshot_operation",
        "snapshot_id": snapshot_id,
        "operation": operation,
        "status": status,
    }
    
    if trigger is not None:
        log_data["trigger"] = trigger
    if event_count is not None:
        log_data["event_count"] = event_count
    if size_bytes is not None:
        log_data["size_bytes"] = size_bytes
    if duration_seconds is not None:
        log_data["duration_seconds"] = duration_seconds
    
    log_data.update(kwargs)
    
    if status == "started":
        logger.info(f"snapshot_{operation}_started", **log_data)
    elif status == "completed":
        logger.info(f"snapshot_{operation}_completed", **log_data)
    elif status == "failed":
        logger.error(f"snapshot_{operation}_failed", **log_data)
    else:
        logger.debug(f"snapshot_{operation}_progress", **log_data)


def log_kafka_consumer_event(
    logger: structlog.stdlib.BoundLogger,
    consumer_group: str,
    topic: str,
    partition: int,
    offset: int,
    event_type: str,
    processing_status: str,
    duration_ms: Optional[float] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a Kafka consumer event.
    
    Args:
        logger: Logger instance
        consumer_group: Consumer group ID
        topic: Topic name
        partition: Partition number
        offset: Message offset
        event_type: Type of event being processed
        processing_status: Processing status (success, error, retry, dlq)
        duration_ms: Processing duration in milliseconds
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "kafka_consumer_event",
        "consumer_group": consumer_group,
        "topic": topic,
        "partition": partition,
        "offset": offset,
        "message_event_type": event_type,
        "processing_status": processing_status,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if processing_status == "success":
        logger.debug("kafka_consumer_event_processed", **log_data)
    elif processing_status == "error":
        logger.error("kafka_consumer_event_failed", **log_data)
    elif processing_status == "dlq":
        logger.warning("kafka_consumer_event_sent_to_dlq", **log_data)
    else:
        logger.info("kafka_consumer_event", **log_data)


def log_dlq_event(
    logger: structlog.stdlib.BoundLogger,
    source_topic: str,
    source_partition: int,
    source_offset: int,
    error_type: str,
    error_message: str,
    retry_count: int,
    **kwargs: Any,
) -> None:
    """
    Log a dead letter queue event.
    
    Args:
        logger: Logger instance
        source_topic: Original topic
        source_partition: Original partition
        source_offset: Original offset
        error_type: Type of error
        error_message: Error message
        retry_count: Number of retries attempted
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "dlq_event",
        "source_topic": source_topic,
        "source_partition": source_partition,
        "source_offset": source_offset,
        "error_type": error_type,
        "error_message": error_message,
        "retry_count": retry_count,
    }
    
    log_data.update(kwargs)
    
    logger.warning("dlq_event", **log_data)



# v0.5 Authority Enforcement Structured Logging Functions

def log_authority_decision(
    logger: structlog.stdlib.BoundLogger,
    decision_outcome: str,
    principal_id: str,
    mandate_id: Optional[str] = None,
    action: Optional[str] = None,
    resource: Optional[str] = None,
    denial_reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log an authority decision.
    
    Args:
        logger: Logger instance
        decision_outcome: Decision outcome ("allowed" or "denied")
        principal_id: Principal ID
        mandate_id: Mandate ID if applicable
        action: Requested action
        resource: Requested resource
        denial_reason: Reason for denial if denied
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    # Get correlation ID from context
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "authority_decision",
        "decision_outcome": decision_outcome,
        "principal_id": principal_id,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if mandate_id is not None:
        log_data["mandate_id"] = mandate_id
    if action is not None:
        log_data["action"] = action
    if resource is not None:
        log_data["resource"] = resource
    if denial_reason is not None:
        log_data["denial_reason"] = denial_reason
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    if decision_outcome == "allowed":
        logger.info("authority_decision_allowed", **log_data)
    else:
        logger.warning("authority_decision_denied", **log_data)


def log_mandate_issuance(
    logger: structlog.stdlib.BoundLogger,
    mandate_id: str,
    issuer_id: str,
    subject_id: str,
    resource_scope: list,
    action_scope: list,
    validity_seconds: int,
    parent_mandate_id: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a mandate issuance.
    
    Args:
        logger: Logger instance
        mandate_id: Mandate ID
        issuer_id: Issuer principal ID
        subject_id: Subject principal ID
        resource_scope: Resource scope list
        action_scope: Action scope list
        validity_seconds: Validity period in seconds
        parent_mandate_id: Parent mandate ID if delegated
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "mandate_issuance",
        "mandate_id": mandate_id,
        "issuer_id": issuer_id,
        "subject_id": subject_id,
        "resource_scope": resource_scope,
        "action_scope": action_scope,
        "validity_seconds": validity_seconds,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if parent_mandate_id is not None:
        log_data["parent_mandate_id"] = parent_mandate_id
        log_data["is_delegated"] = True
    else:
        log_data["is_delegated"] = False
    
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    logger.info("mandate_issued", **log_data)


def log_mandate_validation(
    logger: structlog.stdlib.BoundLogger,
    mandate_id: str,
    principal_id: str,
    action: str,
    resource: str,
    decision: str,
    denial_reason: Optional[str] = None,
    duration_ms: Optional[float] = None,
    **kwargs: Any,
) -> None:
    """
    Log a mandate validation attempt.
    
    Args:
        logger: Logger instance
        mandate_id: Mandate ID
        principal_id: Principal ID
        action: Requested action
        resource: Requested resource
        decision: Validation decision ("allowed" or "denied")
        denial_reason: Reason for denial if denied
        duration_ms: Validation duration in milliseconds
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "mandate_validation",
        "mandate_id": mandate_id,
        "principal_id": principal_id,
        "action": action,
        "resource": resource,
        "decision": decision,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if denial_reason is not None:
        log_data["denial_reason"] = denial_reason
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    if decision == "allowed":
        logger.info("mandate_validation_allowed", **log_data)
    else:
        logger.warning("mandate_validation_denied", **log_data)


def log_mandate_revocation(
    logger: structlog.stdlib.BoundLogger,
    mandate_id: str,
    revoker_id: str,
    reason: str,
    cascade: bool = False,
    child_mandates_revoked: Optional[int] = None,
    **kwargs: Any,
) -> None:
    """
    Log a mandate revocation.
    
    Args:
        logger: Logger instance
        mandate_id: Mandate ID
        revoker_id: Revoker principal ID
        reason: Revocation reason
        cascade: Whether cascade revocation was used
        child_mandates_revoked: Number of child mandates revoked (if cascade)
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "mandate_revocation",
        "mandate_id": mandate_id,
        "revoker_id": revoker_id,
        "reason": reason,
        "cascade": cascade,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if child_mandates_revoked is not None:
        log_data["child_mandates_revoked"] = child_mandates_revoked
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    logger.info("mandate_revoked", **log_data)


def log_authority_policy_change(
    logger: structlog.stdlib.BoundLogger,
    policy_id: str,
    principal_id: str,
    change_type: str,
    changed_by: str,
    change_reason: str,
    before_values: Optional[Dict[str, Any]] = None,
    after_values: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
) -> None:
    """
    Log an authority policy change.
    
    Args:
        logger: Logger instance
        policy_id: Policy ID
        principal_id: Principal ID
        change_type: Type of change (created, modified, deactivated)
        changed_by: Identity of who made the change
        change_reason: Reason for the change
        before_values: Policy values before change
        after_values: Policy values after change
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "authority_policy_change",
        "policy_id": policy_id,
        "principal_id": principal_id,
        "change_type": change_type,
        "changed_by": changed_by,
        "change_reason": change_reason,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if before_values is not None:
        log_data["before_values"] = before_values
    if after_values is not None:
        log_data["after_values"] = after_values
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    logger.info("authority_policy_changed", **log_data)


def log_delegation_chain_validation(
    logger: structlog.stdlib.BoundLogger,
    mandate_id: str,
    principal_id: str,
    chain_depth: int,
    chain_valid: bool,
    invalid_ancestor_id: Optional[str] = None,
    failure_reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a delegation chain validation.
    
    Args:
        logger: Logger instance
        mandate_id: Mandate ID
        principal_id: Principal ID
        chain_depth: Delegation chain depth
        chain_valid: Whether the chain is valid
        invalid_ancestor_id: ID of invalid ancestor if chain is invalid
        failure_reason: Reason for chain validation failure
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "delegation_chain_validation",
        "mandate_id": mandate_id,
        "principal_id": principal_id,
        "chain_depth": chain_depth,
        "chain_valid": chain_valid,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if invalid_ancestor_id is not None:
        log_data["invalid_ancestor_id"] = invalid_ancestor_id
    if failure_reason is not None:
        log_data["failure_reason"] = failure_reason
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    if chain_valid:
        logger.info("delegation_chain_valid", **log_data)
    else:
        logger.warning("delegation_chain_invalid", **log_data)


def log_intent_validation(
    logger: structlog.stdlib.BoundLogger,
    intent_id: str,
    principal_id: str,
    action: str,
    resource: str,
    valid: bool,
    reason: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log an intent validation.
    
    Args:
        logger: Logger instance
        intent_id: Intent ID
        principal_id: Principal ID
        action: Requested action
        resource: Requested resource
        valid: Whether the intent is valid
        reason: Reason for validation result
        **kwargs: Additional context to log
        
    Requirements: 15.6, 15.7
    """
    correlation_id = get_correlation_id()
    
    log_data: Dict[str, Any] = {
        "event_type": "intent_validation",
        "intent_id": intent_id,
        "principal_id": principal_id,
        "action": action,
        "resource": resource,
        "valid": valid,
        "timestamp": structlog.processors.TimeStamper(fmt="iso")(None, None, {})["timestamp"],
    }
    
    if reason is not None:
        log_data["reason"] = reason
    if correlation_id is not None:
        log_data["correlation_id"] = correlation_id
    
    log_data.update(kwargs)
    
    if valid:
        logger.info("intent_valid", **log_data)
    else:
        logger.warning("intent_invalid", **log_data)
