"""
Unit tests for Dead Letter Queue (DLQ) handler.

Tests DLQ event creation, serialization, and basic handler functionality.

Requirements: 15.1, 15.2, 15.4
"""

import json
from datetime import datetime
from unittest.mock import Mock, patch, MagicMock

import pytest

from caracal.kafka.dlq import DLQEvent, DLQHandler, DLQMonitorConsumer


class TestDLQEvent:
    """Test DLQ event data class."""
    
    def test_dlq_event_creation(self):
        """Test creating a DLQ event."""
        event = DLQEvent(
            dlq_id="test-dlq-id",
            original_topic="caracal.metering.events",
            original_partition=0,
            original_offset=123,
            original_key="test-key",
            original_value="test-value",
            error_type="ValueError",
            error_message="Test error",
            retry_count=3,
            failure_timestamp="2024-01-01T00:00:00",
            consumer_group="test-group",
        )
        
        assert event.dlq_id == "test-dlq-id"
        assert event.original_topic == "caracal.metering.events"
        assert event.original_partition == 0
        assert event.original_offset == 123
        assert event.error_type == "ValueError"
        assert event.retry_count == 3
    
    def test_dlq_event_to_dict(self):
        """Test converting DLQ event to dictionary."""
        event = DLQEvent(
            dlq_id="test-dlq-id",
            original_topic="caracal.metering.events",
            original_partition=0,
            original_offset=123,
            original_key="test-key",
            original_value="test-value",
            error_type="ValueError",
            error_message="Test error",
            retry_count=3,
            failure_timestamp="2024-01-01T00:00:00",
            consumer_group="test-group",
        )
        
        event_dict = event.to_dict()
        
        assert event_dict["dlq_id"] == "test-dlq-id"
        assert event_dict["original_topic"] == "caracal.metering.events"
        assert event_dict["error_type"] == "ValueError"
        assert event_dict["retry_count"] == 3
    
    def test_dlq_event_from_dict(self):
        """Test creating DLQ event from dictionary."""
        event_dict = {
            "dlq_id": "test-dlq-id",
            "original_topic": "caracal.metering.events",
            "original_partition": 0,
            "original_offset": 123,
            "original_key": "test-key",
            "original_value": "test-value",
            "error_type": "ValueError",
            "error_message": "Test error",
            "retry_count": 3,
            "failure_timestamp": "2024-01-01T00:00:00",
            "consumer_group": "test-group",
        }
        
        event = DLQEvent.from_dict(event_dict)
        
        assert event.dlq_id == "test-dlq-id"
        assert event.original_topic == "caracal.metering.events"
        assert event.error_type == "ValueError"
        assert event.retry_count == 3
    
    def test_dlq_event_round_trip(self):
        """Test DLQ event serialization round trip."""
        original_event = DLQEvent(
            dlq_id="test-dlq-id",
            original_topic="caracal.metering.events",
            original_partition=0,
            original_offset=123,
            original_key="test-key",
            original_value="test-value",
            error_type="ValueError",
            error_message="Test error",
            retry_count=3,
            failure_timestamp="2024-01-01T00:00:00",
            consumer_group="test-group",
        )
        
        # Convert to dict and back
        event_dict = original_event.to_dict()
        restored_event = DLQEvent.from_dict(event_dict)
        
        assert restored_event.dlq_id == original_event.dlq_id
        assert restored_event.original_topic == original_event.original_topic
        assert restored_event.error_type == original_event.error_type
        assert restored_event.retry_count == original_event.retry_count


class TestDLQHandler:
    """Test DLQ handler."""
    
    @patch('caracal.kafka.dlq.Producer')
    def test_dlq_handler_initialization(self, mock_producer_class):
        """Test DLQ handler initialization."""
        handler = DLQHandler(
            brokers=["localhost:9092"],
            security_protocol="PLAINTEXT",
        )
        
        assert handler.brokers == ["localhost:9092"]
        assert handler.security_protocol == "PLAINTEXT"
        assert handler._producer is None
    
    @patch('caracal.kafka.dlq.Producer')
    def test_send_to_dlq(self, mock_producer_class):
        """Test sending message to DLQ."""
        # Create mock producer
        mock_producer = MagicMock()
        mock_producer_class.return_value = mock_producer
        
        # Create handler
        handler = DLQHandler(
            brokers=["localhost:9092"],
            security_protocol="PLAINTEXT",
        )
        
        # Send to DLQ
        error = ValueError("Test error")
        dlq_id = handler.send_to_dlq(
            original_topic="caracal.metering.events",
            original_partition=0,
            original_offset=123,
            original_key=b"test-key",
            original_value=b"test-value",
            error=error,
            retry_count=3,
            consumer_group="test-group",
        )
        
        # Verify DLQ ID was returned
        assert dlq_id is not None
        assert isinstance(dlq_id, str)
        
        # Verify producer was called
        mock_producer.produce.assert_called_once()
        
        # Verify flush was called
        mock_producer.flush.assert_called_once()
        
        # Verify message content
        call_args = mock_producer.produce.call_args
        assert call_args[1]["topic"] == "caracal.dlq"
        assert call_args[1]["key"] == b"test-key"
        
        # Verify message value contains expected fields
        message_value = json.loads(call_args[1]["value"].decode('utf-8'))
        assert message_value["original_topic"] == "caracal.metering.events"
        assert message_value["original_partition"] == 0
        assert message_value["original_offset"] == 123
        assert message_value["error_type"] == "ValueError"
        assert message_value["error_message"] == "Test error"
        assert message_value["retry_count"] == 3
        assert message_value["consumer_group"] == "test-group"
    
    @patch('caracal.kafka.dlq.Producer')
    def test_send_to_dlq_with_none_key(self, mock_producer_class):
        """Test sending message to DLQ with None key."""
        # Create mock producer
        mock_producer = MagicMock()
        mock_producer_class.return_value = mock_producer
        
        # Create handler
        handler = DLQHandler(
            brokers=["localhost:9092"],
            security_protocol="PLAINTEXT",
        )
        
        # Send to DLQ with None key
        error = ValueError("Test error")
        dlq_id = handler.send_to_dlq(
            original_topic="caracal.metering.events",
            original_partition=0,
            original_offset=123,
            original_key=None,
            original_value=b"test-value",
            error=error,
            retry_count=3,
            consumer_group="test-group",
        )
        
        # Verify DLQ ID was returned
        assert dlq_id is not None
        
        # Verify message value contains None for original_key
        call_args = mock_producer.produce.call_args
        message_value = json.loads(call_args[1]["value"].decode('utf-8'))
        assert message_value["original_key"] is None
    
    @patch('caracal.kafka.dlq.Producer')
    def test_dlq_handler_close(self, mock_producer_class):
        """Test closing DLQ handler."""
        # Create mock producer
        mock_producer = MagicMock()
        mock_producer_class.return_value = mock_producer
        
        # Create handler and trigger producer creation
        handler = DLQHandler(
            brokers=["localhost:9092"],
            security_protocol="PLAINTEXT",
        )
        
        # Send a message to create producer
        error = ValueError("Test error")
        handler.send_to_dlq(
            original_topic="test",
            original_partition=0,
            original_offset=0,
            original_key=None,
            original_value=b"test",
            error=error,
            retry_count=0,
            consumer_group="test",
        )
        
        # Close handler
        handler.close()
        
        # Verify flush was called
        assert mock_producer.flush.call_count >= 2  # Once in send_to_dlq, once in close


class TestDLQMonitorConsumer:
    """Test DLQ monitor consumer."""
    
    def test_dlq_monitor_initialization(self):
        """Test DLQ monitor consumer initialization."""
        monitor = DLQMonitorConsumer(
            brokers=["localhost:9092"],
            consumer_group="test-monitor-group",
            security_protocol="PLAINTEXT",
            alert_threshold=500,
        )
        
        assert monitor.brokers == ["localhost:9092"]
        assert monitor.consumer_group == "test-monitor-group"
        assert monitor.alert_threshold == 500
        assert monitor._dlq_event_count == 0
        assert not monitor.is_running()
    
    def test_get_dlq_event_count(self):
        """Test getting DLQ event count."""
        monitor = DLQMonitorConsumer(
            brokers=["localhost:9092"],
            consumer_group="test-monitor-group",
        )
        
        assert monitor.get_dlq_event_count() == 0
        
        # Simulate processing events
        monitor._dlq_event_count = 10
        assert monitor.get_dlq_event_count() == 10


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
