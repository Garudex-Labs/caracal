"""Helper utilities for testing."""
from typing import Any, Callable, Optional
import time
import functools


def retry_on_failure(max_attempts: int = 3, delay: float = 0.1):
    """Decorator to retry a test function on failure."""
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_attempts - 1:
                        time.sleep(delay)
            raise last_exception
        return wrapper
    return decorator


def assert_eventually(
    condition: Callable[[], bool],
    timeout: float = 5.0,
    interval: float = 0.1,
    message: Optional[str] = None
):
    """Assert that a condition becomes true within a timeout."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        if condition():
            return
        time.sleep(interval)
    
    error_msg = message or "Condition did not become true within timeout"
    raise AssertionError(error_msg)


def wait_for(
    func: Callable[[], Any],
    timeout: float = 5.0,
    interval: float = 0.1
) -> Any:
    """Wait for a function to return a truthy value."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        result = func()
        if result:
            return result
        time.sleep(interval)
    
    raise TimeoutError(f"Function did not return truthy value within {timeout}s")


def generate_test_id(prefix: str = "test") -> str:
    """Generate a unique test ID."""
    import uuid
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def compare_dicts(dict1: dict, dict2: dict, ignore_keys: Optional[list] = None) -> bool:
    """Compare two dictionaries, optionally ignoring certain keys."""
    ignore_keys = ignore_keys or []
    
    keys1 = set(dict1.keys()) - set(ignore_keys)
    keys2 = set(dict2.keys()) - set(ignore_keys)
    
    if keys1 != keys2:
        return False
    
    for key in keys1:
        if dict1[key] != dict2[key]:
            return False
    
    return True
