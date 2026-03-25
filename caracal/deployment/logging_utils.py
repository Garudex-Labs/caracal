"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Logging utilities for deployment architecture.

Provides structured logging functions specific to deployment operations.
"""

from typing import Any, Dict, Optional

import structlog


def log_mode_change(
    logger: structlog.stdlib.BoundLogger,
    old_mode: str,
    new_mode: str,
    changed_by: str,
    **kwargs: Any,
) -> None:
    """
    Log a mode change operation.
    
    Args:
        logger: Logger instance
        old_mode: Previous mode
        new_mode: New mode
        changed_by: Identity of who made the change
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "mode_change",
        "old_mode": old_mode,
        "new_mode": new_mode,
        "changed_by": changed_by,
    }
    
    log_data.update(kwargs)
    logger.info("mode_changed", **log_data)


def log_edition_change(
    logger: structlog.stdlib.BoundLogger,
    old_edition: str,
    new_edition: str,
    changed_by: str,
    **kwargs: Any,
) -> None:
    """
    Log an edition change operation.
    
    Args:
        logger: Logger instance
        old_edition: Previous edition
        new_edition: New edition
        changed_by: Identity of who made the change
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "edition_change",
        "old_edition": old_edition,
        "new_edition": new_edition,
        "changed_by": changed_by,
    }
    
    log_data.update(kwargs)
    logger.info("edition_changed", **log_data)


def log_workspace_operation(
    logger: structlog.stdlib.BoundLogger,
    operation: str,
    workspace: str,
    success: bool,
    duration_ms: Optional[float] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a workspace operation.
    
    Args:
        logger: Logger instance
        operation: Operation type (create, delete, export, import)
        workspace: Workspace name
        success: Whether operation succeeded
        duration_ms: Operation duration in milliseconds
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "workspace_operation",
        "operation": operation,
        "workspace": workspace,
        "success": success,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if success:
        logger.info(f"workspace_{operation}_success", **log_data)
    else:
        logger.error(f"workspace_{operation}_failed", **log_data)


def log_sync_operation(
    logger: structlog.stdlib.BoundLogger,
    workspace: str,
    direction: str,
    success: bool,
    uploaded: int = 0,
    downloaded: int = 0,
    conflicts: int = 0,
    duration_ms: Optional[float] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a sync operation.
    
    Args:
        logger: Logger instance
        workspace: Workspace name
        direction: Sync direction (push, pull, both)
        success: Whether sync succeeded
        uploaded: Number of items uploaded
        downloaded: Number of items downloaded
        conflicts: Number of conflicts detected
        duration_ms: Sync duration in milliseconds
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "sync_operation",
        "workspace": workspace,
        "direction": direction,
        "success": success,
        "uploaded": uploaded,
        "downloaded": downloaded,
        "conflicts": conflicts,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if success:
        logger.info("sync_completed", **log_data)
    else:
        logger.error("sync_failed", **log_data)


def log_provider_call(
    logger: structlog.stdlib.BoundLogger,
    provider: str,
    operation: str,
    success: bool,
    duration_ms: Optional[float] = None,
    status_code: Optional[int] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a provider API call.
    
    Args:
        logger: Logger instance
        provider: Provider name
        operation: Operation type
        success: Whether call succeeded
        duration_ms: Call duration in milliseconds
        status_code: HTTP status code
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "provider_call",
        "provider": provider,
        "operation": operation,
        "success": success,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if status_code is not None:
        log_data["status_code"] = status_code
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if success:
        logger.info("provider_call_success", **log_data)
    else:
        logger.warning("provider_call_failed", **log_data)


def log_encryption_operation(
    logger: structlog.stdlib.BoundLogger,
    operation: str,
    key_id: str,
    success: bool,
    duration_ms: Optional[float] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log an encryption/decryption operation.
    
    Args:
        logger: Logger instance
        operation: Operation type (encrypt, decrypt)
        key_id: Key identifier
        success: Whether operation succeeded
        duration_ms: Operation duration in milliseconds
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "encryption_operation",
        "operation": operation,
        "key_id": key_id,
        "success": success,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if success:
        logger.debug(f"{operation}_success", **log_data)
    else:
        logger.error(f"{operation}_failed", **log_data)


def log_migration_operation(
    logger: structlog.stdlib.BoundLogger,
    migration_type: str,
    success: bool,
    items_migrated: int = 0,
    duration_ms: Optional[float] = None,
    error: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """
    Log a migration operation.
    
    Args:
        logger: Logger instance
        migration_type: Type of migration
        success: Whether migration succeeded
        items_migrated: Number of items migrated
        duration_ms: Migration duration in milliseconds
        error: Error message if failed
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "migration_operation",
        "migration_type": migration_type,
        "success": success,
        "items_migrated": items_migrated,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    if error is not None:
        log_data["error"] = error
    
    log_data.update(kwargs)
    
    if success:
        logger.info("migration_completed", **log_data)
    else:
        logger.error("migration_failed", **log_data)


def log_health_check(
    logger: structlog.stdlib.BoundLogger,
    check_name: str,
    status: str,
    message: str,
    duration_ms: Optional[float] = None,
    **kwargs: Any,
) -> None:
    """
    Log a health check result.
    
    Args:
        logger: Logger instance
        check_name: Name of the health check
        status: Check status (pass, warn, fail)
        message: Status message
        duration_ms: Check duration in milliseconds
        **kwargs: Additional context to log
    """
    log_data: Dict[str, Any] = {
        "event_type": "health_check",
        "check_name": check_name,
        "status": status,
        "message": message,
    }
    
    if duration_ms is not None:
        log_data["duration_ms"] = duration_ms
    
    log_data.update(kwargs)
    
    if status == "pass":
        logger.info("health_check_passed", **log_data)
    elif status == "warn":
        logger.warning("health_check_warning", **log_data)
    else:
        logger.error("health_check_failed", **log_data)
