"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Retry logic utilities for Caracal Core.

This module provides retry decorators and utilities for handling transient failures
in file persistence operations and database queries.

Requirements: 23.1
"""

import functools
import time
from typing import Callable, Type, Tuple, TypeVar, Any

from caracal.logging_config import get_logger

logger = get_logger(__name__)

T = TypeVar('T')


def retry_on_transient_failure(
    max_retries: int = 3,
    base_delay: float = 0.1,
    backoff_factor: float = 2.0,
    transient_exceptions: Tuple[Type[Exception], ...] = (OSError, IOError)
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Decorator to retry a function on transient failures with exponential backoff.
    
    Args:
        max_retries: Maximum number of retry attempts (default: 3)
        base_delay: Initial delay in seconds before first retry (default: 0.1)
        backoff_factor: Multiplier for delay between retries (default: 2.0)
        transient_exceptions: Tuple of exception types to retry on (default: OSError, IOError)
        
    Returns:
        Decorated function that retries on transient failures
        
    Example:
        @retry_on_transient_failure(max_retries=3)
        def write_file(path, content):
            with open(path, 'w') as f:
                f.write(content)
    """
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            last_exception = None
            
            for attempt in range(max_retries + 1):  # +1 for initial attempt
                try:
                    return func(*args, **kwargs)
                except transient_exceptions as e:
                    last_exception = e
                    
                    if attempt < max_retries:
                        # Calculate delay with exponential backoff
                        delay = base_delay * (backoff_factor ** attempt)
                        
                        logger.warning(
                            f"Transient failure in {func.__name__} (attempt {attempt + 1}/{max_retries + 1}): {e}. "
                            f"Retrying in {delay:.2f}s..."
                        )
                        
                        time.sleep(delay)
                    else:
                        # Max retries exceeded
                        logger.error(
                            f"Permanent failure in {func.__name__} after {max_retries + 1} attempts: {e}",
                            exc_info=True
                        )
            
            # Re-raise the last exception after all retries exhausted
            raise last_exception
        
        return wrapper
    return decorator


def retry_write_operation(
    operation: Callable[[], T],
    operation_name: str,
    max_retries: int = 3,
    base_delay: float = 0.1,
    backoff_factor: float = 2.0
) -> T:
    """
    Execute a write operation with retry logic.
    
    This is a functional alternative to the decorator for cases where
    you want to wrap a specific operation without decorating a function.
    
    Args:
        operation: Callable to execute
        operation_name: Name of the operation for logging
        max_retries: Maximum number of retry attempts (default: 3)
        base_delay: Initial delay in seconds before first retry (default: 0.1)
        backoff_factor: Multiplier for delay between retries (default: 2.0)
        
    Returns:
        Result of the operation
        
    Raises:
        Exception: The last exception if all retries fail
        
    Example:
        result = retry_write_operation(
            lambda: write_to_file(path, data),
            "write_to_file",
            max_retries=3
        )
    """
    last_exception = None
    transient_exceptions = (OSError, IOError)
    
    for attempt in range(max_retries + 1):  # +1 for initial attempt
        try:
            return operation()
        except transient_exceptions as e:
            last_exception = e
            
            if attempt < max_retries:
                # Calculate delay with exponential backoff
                delay = base_delay * (backoff_factor ** attempt)
                
                logger.warning(
                    f"Transient failure in {operation_name} (attempt {attempt + 1}/{max_retries + 1}): {e}. "
                    f"Retrying in {delay:.2f}s..."
                )
                
                time.sleep(delay)
            else:
                # Max retries exceeded
                logger.error(
                    f"Permanent failure in {operation_name} after {max_retries + 1} attempts: {e}",
                    exc_info=True
                )
    
    # Re-raise the last exception after all retries exhausted
    raise last_exception


def retry_database_operation(
    max_retries: int = 3,
    base_delay: float = 0.1,
    backoff_factor: float = 2.0,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Decorator to retry database operations on transient failures with exponential backoff.
    
    This decorator is specifically designed for database operations and handles
    SQLAlchemy-specific exceptions that indicate transient failures (connection errors,
    timeouts, deadlocks, etc.).
    
    Transient database exceptions that trigger retry:
    - OperationalError: Connection failures, timeouts
    - DatabaseError: General database errors
    - InterfaceError: Low-level database interface errors
    - InternalError: Internal database errors (e.g., deadlocks)
    
    Args:
        max_retries: Maximum number of retry attempts (default: 3)
        base_delay: Initial delay in seconds before first retry (default: 0.1)
        backoff_factor: Multiplier for delay between retries (default: 2.0)
        
    Returns:
        Decorated function that retries on transient database failures
        
    Example:
        @retry_database_operation(max_retries=3)
        def query_principal(session, principal_id):
            return session.query(Principal).filter_by(id=principal_id).first()
            
    Requirements: 23.1
    """
    # Import SQLAlchemy exceptions here to avoid circular imports
    try:
        from sqlalchemy.exc import (
            OperationalError,
            DatabaseError,
            InterfaceError,
            InternalError,
        )
        transient_exceptions = (
            OperationalError,
            DatabaseError,
            InterfaceError,
            InternalError,
        )
    except ImportError:
        # Fallback if SQLAlchemy not available
        logger.warning(
            "SQLAlchemy not available, retry_database_operation will not catch database exceptions"
        )
        transient_exceptions = ()
    
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            last_exception = None
            
            for attempt in range(max_retries + 1):  # +1 for initial attempt
                try:
                    return func(*args, **kwargs)
                except transient_exceptions as e:
                    last_exception = e
                    
                    if attempt < max_retries:
                        # Calculate delay with exponential backoff
                        delay = base_delay * (backoff_factor ** attempt)
                        
                        logger.warning(
                            f"Transient database failure in {func.__name__} "
                            f"(attempt {attempt + 1}/{max_retries + 1}): {type(e).__name__}: {e}. "
                            f"Retrying in {delay:.2f}s...",
                            extra={
                                "function": func.__name__,
                                "attempt": attempt + 1,
                                "max_attempts": max_retries + 1,
                                "delay_seconds": delay,
                                "exception_type": type(e).__name__,
                                "exception_message": str(e),
                            }
                        )
                        
                        time.sleep(delay)
                    else:
                        # Max retries exceeded
                        logger.error(
                            f"Permanent database failure in {func.__name__} "
                            f"after {max_retries + 1} attempts: {type(e).__name__}: {e}",
                            exc_info=True,
                            extra={
                                "function": func.__name__,
                                "total_attempts": max_retries + 1,
                                "exception_type": type(e).__name__,
                                "exception_message": str(e),
                            }
                        )
            
            # Re-raise the last exception after all retries exhausted
            raise last_exception
        
        return wrapper
    return decorator


def retry_database_query(
    operation: Callable[[], T],
    operation_name: str,
    max_retries: int = 3,
    base_delay: float = 0.1,
    backoff_factor: float = 2.0
) -> T:
    """
    Execute a database query with retry logic.
    
    This is a functional alternative to the decorator for cases where
    you want to wrap a specific database operation without decorating a function.
    
    Args:
        operation: Callable to execute (database query)
        operation_name: Name of the operation for logging
        max_retries: Maximum number of retry attempts (default: 3)
        base_delay: Initial delay in seconds before first retry (default: 0.1)
        backoff_factor: Multiplier for delay between retries (default: 2.0)
        
    Returns:
        Result of the operation
        
    Raises:
        Exception: The last exception if all retries fail
        
    Example:
        result = retry_database_query(
            lambda: session.query(Principal).filter_by(id=principal_id).first(),
            "query_principal",
            max_retries=3
        )
        
    Requirements: 23.1
    """
    # Import SQLAlchemy exceptions here to avoid circular imports
    try:
        from sqlalchemy.exc import (
            OperationalError,
            DatabaseError,
            InterfaceError,
            InternalError,
        )
        transient_exceptions = (
            OperationalError,
            DatabaseError,
            InterfaceError,
            InternalError,
        )
    except ImportError:
        # Fallback if SQLAlchemy not available
        logger.warning(
            "SQLAlchemy not available, retry_database_query will not catch database exceptions"
        )
        transient_exceptions = ()
    
    last_exception = None
    
    for attempt in range(max_retries + 1):  # +1 for initial attempt
        try:
            return operation()
        except transient_exceptions as e:
            last_exception = e
            
            if attempt < max_retries:
                # Calculate delay with exponential backoff
                delay = base_delay * (backoff_factor ** attempt)
                
                logger.warning(
                    f"Transient database failure in {operation_name} "
                    f"(attempt {attempt + 1}/{max_retries + 1}): {type(e).__name__}: {e}. "
                    f"Retrying in {delay:.2f}s...",
                    extra={
                        "operation": operation_name,
                        "attempt": attempt + 1,
                        "max_attempts": max_retries + 1,
                        "delay_seconds": delay,
                        "exception_type": type(e).__name__,
                        "exception_message": str(e),
                    }
                )
                
                time.sleep(delay)
            else:
                # Max retries exceeded
                logger.error(
                    f"Permanent database failure in {operation_name} "
                    f"after {max_retries + 1} attempts: {type(e).__name__}: {e}",
                    exc_info=True,
                    extra={
                        "operation": operation_name,
                        "total_attempts": max_retries + 1,
                        "exception_type": type(e).__name__,
                        "exception_message": str(e),
                    }
                )
    
    # Re-raise the last exception after all retries exhausted
    raise last_exception
