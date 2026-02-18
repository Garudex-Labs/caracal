"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for retry logic utilities.
"""

import pytest
import time
from unittest.mock import Mock, patch

from caracal.core.retry import (
    retry_on_transient_failure,
    retry_write_operation,
    retry_database_operation,
    retry_database_query,
)


class TestRetryDecorator:
    """Tests for retry_on_transient_failure decorator."""
    
    def test_successful_operation_no_retry(self):
        """Test that successful operations don't trigger retries."""
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3)
        def successful_operation():
            nonlocal call_count
            call_count += 1
            return "success"
        
        result = successful_operation()
        
        assert result == "success"
        assert call_count == 1  # Called only once
    
    def test_transient_failure_with_retry(self):
        """Test that transient failures trigger retries."""
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3, base_delay=0.01)
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise OSError("Transient failure")
            return "success"
        
        result = failing_then_succeeding()
        
        assert result == "success"
        assert call_count == 3  # Failed twice, succeeded on third attempt
    
    def test_permanent_failure_after_max_retries(self):
        """Test that permanent failure occurs after max retries."""
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3, base_delay=0.01)
        def always_failing():
            nonlocal call_count
            call_count += 1
            raise OSError("Permanent failure")
        
        with pytest.raises(OSError, match="Permanent failure"):
            always_failing()
        
        assert call_count == 4  # Initial attempt + 3 retries
    
    def test_non_transient_exception_not_retried(self):
        """Test that non-transient exceptions are not retried."""
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3)
        def non_transient_failure():
            nonlocal call_count
            call_count += 1
            raise ValueError("Non-transient error")
        
        with pytest.raises(ValueError, match="Non-transient error"):
            non_transient_failure()
        
        assert call_count == 1  # No retries for non-transient exceptions
    
    def test_exponential_backoff(self):
        """Test that exponential backoff is applied correctly."""
        call_times = []
        
        @retry_on_transient_failure(max_retries=3, base_delay=0.1, backoff_factor=2.0)
        def failing_operation():
            call_times.append(time.time())
            if len(call_times) < 4:
                raise OSError("Transient failure")
            return "success"
        
        result = failing_operation()
        
        assert result == "success"
        assert len(call_times) == 4
        
        # Check delays between attempts (with some tolerance for timing)
        # Expected delays: 0.1s, 0.2s, 0.4s
        delay1 = call_times[1] - call_times[0]
        delay2 = call_times[2] - call_times[1]
        delay3 = call_times[3] - call_times[2]
        
        assert 0.08 < delay1 < 0.15  # ~0.1s with tolerance
        assert 0.18 < delay2 < 0.25  # ~0.2s with tolerance
        assert 0.38 < delay3 < 0.45  # ~0.4s with tolerance


class TestRetryWriteOperation:
    """Tests for retry_write_operation function."""
    
    def test_successful_operation_no_retry(self):
        """Test that successful operations don't trigger retries."""
        call_count = 0
        
        def successful_operation():
            nonlocal call_count
            call_count += 1
            return "success"
        
        result = retry_write_operation(
            successful_operation,
            "test_operation",
            max_retries=3
        )
        
        assert result == "success"
        assert call_count == 1
    
    def test_transient_failure_with_retry(self):
        """Test that transient failures trigger retries."""
        call_count = 0
        
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise IOError("Transient failure")
            return "success"
        
        result = retry_write_operation(
            failing_then_succeeding,
            "test_operation",
            max_retries=3,
            base_delay=0.01
        )
        
        assert result == "success"
        assert call_count == 3
    
    def test_permanent_failure_after_max_retries(self):
        """Test that permanent failure occurs after max retries."""
        call_count = 0
        
        def always_failing():
            nonlocal call_count
            call_count += 1
            raise OSError("Permanent failure")
        
        with pytest.raises(OSError, match="Permanent failure"):
            retry_write_operation(
                always_failing,
                "test_operation",
                max_retries=3,
                base_delay=0.01
            )
        
        assert call_count == 4  # Initial attempt + 3 retries



class TestDatabaseRetryDecorator:
    """Tests for retry_database_operation decorator."""
    
    def test_successful_query_no_retry(self):
        """Test that successful database queries don't trigger retries."""
        call_count = 0
        
        @retry_database_operation(max_retries=3)
        def successful_query():
            nonlocal call_count
            call_count += 1
            return {"id": 1, "name": "test"}
        
        result = successful_query()
        
        assert result == {"id": 1, "name": "test"}
        assert call_count == 1  # Called only once
    
    def test_operational_error_with_retry(self):
        """Test that OperationalError triggers retries."""
        from sqlalchemy.exc import OperationalError
        
        call_count = 0
        
        @retry_database_operation(max_retries=3, base_delay=0.01)
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise OperationalError("Connection timeout", None, None)
            return "success"
        
        result = failing_then_succeeding()
        
        assert result == "success"
        assert call_count == 3  # Failed twice, succeeded on third attempt
    
    def test_database_error_with_retry(self):
        """Test that DatabaseError triggers retries."""
        from sqlalchemy.exc import DatabaseError
        
        call_count = 0
        
        @retry_database_operation(max_retries=3, base_delay=0.01)
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise DatabaseError("Database error", None, None)
            return "success"
        
        result = failing_then_succeeding()
        
        assert result == "success"
        assert call_count == 2  # Failed once, succeeded on second attempt
    
    def test_interface_error_with_retry(self):
        """Test that InterfaceError triggers retries."""
        from sqlalchemy.exc import InterfaceError
        
        call_count = 0
        
        @retry_database_operation(max_retries=3, base_delay=0.01)
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise InterfaceError("Interface error", None, None)
            return "success"
        
        result = failing_then_succeeding()
        
        assert result == "success"
        assert call_count == 2
    
    def test_internal_error_with_retry(self):
        """Test that InternalError (e.g., deadlock) triggers retries."""
        from sqlalchemy.exc import InternalError
        
        call_count = 0
        
        @retry_database_operation(max_retries=3, base_delay=0.01)
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise InternalError("Deadlock detected", None, None)
            return "success"
        
        result = failing_then_succeeding()
        
        assert result == "success"
        assert call_count == 2
    
    def test_permanent_failure_after_max_retries(self):
        """Test that permanent failure occurs after max retries."""
        from sqlalchemy.exc import OperationalError
        
        call_count = 0
        
        @retry_database_operation(max_retries=3, base_delay=0.01)
        def always_failing():
            nonlocal call_count
            call_count += 1
            raise OperationalError("Connection refused", None, None)
        
        with pytest.raises(OperationalError, match="Connection refused"):
            always_failing()
        
        assert call_count == 4  # Initial attempt + 3 retries
    
    def test_non_database_exception_not_retried(self):
        """Test that non-database exceptions are not retried."""
        call_count = 0
        
        @retry_database_operation(max_retries=3)
        def non_database_failure():
            nonlocal call_count
            call_count += 1
            raise ValueError("Business logic error")
        
        with pytest.raises(ValueError, match="Business logic error"):
            non_database_failure()
        
        assert call_count == 1  # No retries for non-database exceptions
    
    def test_exponential_backoff_database(self):
        """Test that exponential backoff is applied correctly for database operations."""
        from sqlalchemy.exc import OperationalError
        
        call_times = []
        
        @retry_database_operation(max_retries=3, base_delay=0.1, backoff_factor=2.0)
        def failing_operation():
            call_times.append(time.time())
            if len(call_times) < 4:
                raise OperationalError("Connection timeout", None, None)
            return "success"
        
        result = failing_operation()
        
        assert result == "success"
        assert len(call_times) == 4
        
        # Check delays between attempts (with some tolerance for timing)
        # Expected delays: 0.1s, 0.2s, 0.4s
        delay1 = call_times[1] - call_times[0]
        delay2 = call_times[2] - call_times[1]
        delay3 = call_times[3] - call_times[2]
        
        assert 0.08 < delay1 < 0.15  # ~0.1s with tolerance
        assert 0.18 < delay2 < 0.25  # ~0.2s with tolerance
        assert 0.38 < delay3 < 0.45  # ~0.4s with tolerance


class TestDatabaseRetryQuery:
    """Tests for retry_database_query function."""
    
    def test_successful_query_no_retry(self):
        """Test that successful queries don't trigger retries."""
        call_count = 0
        
        def successful_query():
            nonlocal call_count
            call_count += 1
            return {"id": 1, "name": "test"}
        
        result = retry_database_query(
            successful_query,
            "test_query",
            max_retries=3
        )
        
        assert result == {"id": 1, "name": "test"}
        assert call_count == 1
    
    def test_operational_error_with_retry(self):
        """Test that OperationalError triggers retries."""
        from sqlalchemy.exc import OperationalError
        
        call_count = 0
        
        def failing_then_succeeding():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise OperationalError("Connection timeout", None, None)
            return "success"
        
        result = retry_database_query(
            failing_then_succeeding,
            "test_query",
            max_retries=3,
            base_delay=0.01
        )
        
        assert result == "success"
        assert call_count == 3
    
    def test_permanent_failure_after_max_retries(self):
        """Test that permanent failure occurs after max retries."""
        from sqlalchemy.exc import OperationalError
        
        call_count = 0
        
        def always_failing():
            nonlocal call_count
            call_count += 1
            raise OperationalError("Connection refused", None, None)
        
        with pytest.raises(OperationalError, match="Connection refused"):
            retry_database_query(
                always_failing,
                "test_query",
                max_retries=3,
                base_delay=0.01
            )
        
        assert call_count == 4  # Initial attempt + 3 retries
