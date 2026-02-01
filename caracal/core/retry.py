"""
Retry logic utilities for Caracal Core.

This module provides retry decorators and utilities for handling transient failures
in file persistence operations.
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
