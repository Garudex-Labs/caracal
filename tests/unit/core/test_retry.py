"""
Unit tests for Retry logic functionality.

This module tests retry decorators and utilities.
"""
import pytest
import time
from unittest.mock import Mock, patch

from caracal.core.retry import (
    retry_on_transient_failure,
    retry_write_operation,
    retry_database_operation,
    retry_database_query
)


@pytest.mark.unit
class TestRetryOnTransientFailure:
    """Test suite for retry_on_transient_failure decorator."""
    
    def test_successful_operation_no_retry(self):
        """Test successful operation executes without retry."""
        # Arrange
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3)
        def successful_operation():
            nonlocal call_count
            call_count += 1
            return "success"
        
        # Act
        result = successful_operation()
        
        # Assert
        assert result == "success"
        assert call_count == 1  # Called only once
    
    def test_transient_failure_retries(self):
        """Test transient failure triggers retry."""
        # Arrange
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3, base_delay=0.01)
        def failing_then_success():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise OSError("Transient error")
            return "success"
        
        # Act
        result = failing_then_success()
        
        # Assert
        assert result == "success"
        assert call_count == 3  # Failed twice, succeeded on third
    
    def test_max_retries_exceeded(self):
        """Test operation fails after max retries exceeded."""
        # Arrange
        call_count = 0
        
        @retry_on_transient_failure(max_retries=2, base_delay=0.01)
        def always_failing():
            nonlocal call_count
            call_count += 1
            raise OSError("Persistent error")
        
        # Act & Assert
        with pytest.raises(OSError) as exc_info:
            always_failing()
        
        assert "Persistent error" in str(exc_info.value)
        assert call_count == 3  # Initial + 2 retries
    
    def test_exponential_backoff(self):
        """Test retry uses exponential backoff."""
        # Arrange
        call_times = []
        
        @retry_on_transient_failure(max_retries=3, base_delay=0.1, backoff_factor=2.0)
        def failing_operation():
            call_times.append(time.time())
            if len(call_times) < 3:
                raise OSError("Transient error")
            return "success"
        
        # Act
        result = failing_operation()
        
        # Assert
        assert result == "success"
        assert len(call_times) == 3
        
        # Check delays are approximately exponential
        delay1 = call_times[1] - call_times[0]
        delay2 = call_times[2] - call_times[1]
        
        # First delay ~0.1s, second delay ~0.2s
        assert 0.08 < delay1 < 0.15
        assert 0.18 < delay2 < 0.25
    
    def test_non_transient_exception_not_retried(self):
        """Test non-transient exceptions are not retried."""
        # Arrange
        call_count = 0
        
        @retry_on_transient_failure(max_retries=3)
        def non_transient_error():
            nonlocal call_count
            call_count += 1
            raise ValueError("Non-transient error")
        
        # Act & Assert
        with pytest.raises(ValueError):
            non_transient_error()
        
        assert call_count == 1  # Not retried
    
    def test_custom_transient_exceptions(self):
        """Test retry with custom transient exception types."""
        # Arrange
        call_count = 0
        
        @retry_on_transient_failure(
            max_retries=2,
            base_delay=0.01,
            transient_exceptions=(ValueError, TypeError)
        )
        def custom_transient():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ValueError("Custom transient")
            return "success"
        
        # Act
        result = custom_transient()
        
        # Assert
        assert result == "success"
        assert call_count == 2


@pytest.mark.unit
class TestRetryWriteOperation:
    """Test suite for retry_write_operation function."""
    
    def test_successful_write_no_retry(self):
        """Test successful write operation without retry."""
        # Arrange
        call_count = 0
        
        def write_op():
            nonlocal call_count
            call_count += 1
            return "written"
        
        # Act
        result = retry_write_operation(write_op, "test_write")
        
        # Assert
        assert result == "written"
        assert call_count == 1
    
    def test_transient_write_failure_retries(self):
        """Test transient write failure triggers retry."""
        # Arrange
        call_count = 0
        
        def write_op():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise IOError("Disk full")
            return "written"
        
        # Act
        result = retry_write_operation(
            write_op,
            "test_write",
            max_retries=3,
            base_delay=0.01
        )
        
        # Assert
        assert result == "written"
        assert call_count == 3
    
    def test_write_operation_max_retries_exceeded(self):
        """Test write operation fails after max retries."""
        # Arrange
        def always_failing():
            raise OSError("Persistent disk error")
        
        # Act & Assert
        with pytest.raises(OSError):
            retry_write_operation(
                always_failing,
                "test_write",
                max_retries=2,
                base_delay=0.01
            )


@pytest.mark.unit
class TestRetryDatabaseOperation:
    """Test suite for retry_database_operation decorator."""
    
    def test_successful_db_operation_no_retry(self):
        """Test successful database operation without retry."""
        # Arrange
        call_count = 0
        
        @retry_database_operation(max_retries=3)
        def db_query():
            nonlocal call_count
            call_count += 1
            return "result"
        
        # Act
        result = db_query()
        
        # Assert
        assert result == "result"
        assert call_count == 1
    
    @patch('caracal.core.retry.OperationalError', create=True)
    def test_database_error_retries(self, mock_op_error):
        """Test database operational error triggers retry."""
        # Arrange
        call_count = 0
        
        # Create a mock exception class
        class MockOperationalError(Exception):
            pass
        
        mock_op_error.side_effect = lambda msg: MockOperationalError(msg)
        
        @retry_database_operation(max_retries=2, base_delay=0.01)
        def db_query():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise MockOperationalError("Connection lost")
            return "result"
        
        # Act
        result = db_query()
        
        # Assert
        assert result == "result"
        assert call_count == 2
    
    def test_database_operation_logs_attempts(self):
        """Test database operation logs retry attempts."""
        # Arrange
        @retry_database_operation(max_retries=2, base_delay=0.01)
        def db_query():
            return "result"
        
        # Act
        with patch('caracal.core.retry.logger') as mock_logger:
            result = db_query()
        
        # Assert
        assert result == "result"
        # Logger should not be called for successful operation
        assert mock_logger.warning.call_count == 0


@pytest.mark.unit
class TestRetryDatabaseQuery:
    """Test suite for retry_database_query function."""
    
    def test_successful_query_no_retry(self):
        """Test successful database query without retry."""
        # Arrange
        call_count = 0
        
        def query_op():
            nonlocal call_count
            call_count += 1
            return "query_result"
        
        # Act
        result = retry_database_query(query_op, "test_query")
        
        # Assert
        assert result == "query_result"
        assert call_count == 1
    
    def test_query_with_custom_retry_params(self):
        """Test database query with custom retry parameters."""
        # Arrange
        call_count = 0
        
        def query_op():
            nonlocal call_count
            call_count += 1
            return "result"
        
        # Act
        result = retry_database_query(
            query_op,
            "test_query",
            max_retries=5,
            base_delay=0.05,
            backoff_factor=3.0
        )
        
        # Assert
        assert result == "result"
        assert call_count == 1


@pytest.mark.unit
class TestRetryErrorHandling:
    """Test suite for retry error handling."""
    
    def test_retry_preserves_exception_type(self):
        """Test retry preserves original exception type."""
        # Arrange
        @retry_on_transient_failure(max_retries=1, base_delay=0.01)
        def failing_op():
            raise OSError("Test error")
        
        # Act & Assert
        with pytest.raises(OSError) as exc_info:
            failing_op()
        
        assert "Test error" in str(exc_info.value)
    
    def test_retry_preserves_exception_message(self):
        """Test retry preserves original exception message."""
        # Arrange
        @retry_on_transient_failure(max_retries=1, base_delay=0.01)
        def failing_op():
            raise IOError("Specific error message")
        
        # Act & Assert
        with pytest.raises(IOError) as exc_info:
            failing_op()
        
        assert "Specific error message" in str(exc_info.value)
