"""
Unit tests for Kafka Event Producer.

Tests the KafkaEventProducer class for publishing events to Kafka topics.
"""

import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import Mock, AsyncMock, patch, MagicMock

from caracal.kafka.producer import (
    KafkaEventProducer,
    KafkaConfig,
    ProducerConfig,
    MeteringEvent,
    PolicyDecisionEvent,
    AgentLifecycleEvent,
    PolicyChangeEvent,
)
from caracal.exceptions import KafkaPublishError

# Mark all async tests in this module to use asyncio
pytestmark = pytest.mark.asyncio(loop_scope="function")


@pytest.fixture
def kafka_config():
    """Create a test Kafka configuration."""
    return KafkaConfig(
        brokers=["localhost:9092"],
        security_protocol="PLAINTEXT",
        producer_config=ProducerConfig(
            acks="all",
            retries=3,
            enable_idempotence=True
        )
    )


@pytest.fixture
def kafka_producer(kafka_config):
    """Create a test Kafka producer."""
    return KafkaEventProducer(kafka_config)


class TestKafkaEventProducer:
    """Test suite for KafkaEventProducer."""
    
    def test_initialization(self, kafka_producer, kafka_config):
        """Test that KafkaEventProducer initializes correctly."""
        assert kafka_producer.config == kafka_config
        assert kafka_producer._producer is None
        assert kafka_producer._initialized is False
    
    @patch('caracal.kafka.producer.Producer')
    async def test_publish_metering_event(self, mock_producer_class, kafka_producer):
        """Test publishing a metering event."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.produce = Mock()
        mock_producer.poll = Mock()
        mock_producer_class.return_value = mock_producer
        
        # Publish event
        await kafka_producer.publish_metering_event(
            agent_id="test-agent-123",
            resource_type="api_call",
            quantity=Decimal("1.0"),
            cost=Decimal("0.50"),
            currency="USD",
            provisional_charge_id="charge-123",
            metadata={"test": "value"},
            timestamp=datetime(2024, 1, 1, 12, 0, 0)
        )
        
        # Verify producer was called
        assert mock_producer.produce.called
        call_args = mock_producer.produce.call_args
        assert call_args[1]['topic'] == KafkaEventProducer.TOPIC_METERING
    
    @patch('caracal.kafka.producer.Producer')
    async def test_publish_policy_decision(self, mock_producer_class, kafka_producer):
        """Test publishing a policy decision event."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.produce = Mock()
        mock_producer.poll = Mock()
        mock_producer_class.return_value = mock_producer
        
        # Publish event
        await kafka_producer.publish_policy_decision(
            agent_id="test-agent-123",
            decision="allowed",
            reason="Within budget",
            policy_id="policy-123",
            estimated_cost=Decimal("0.50"),
            remaining_budget=Decimal("9.50"),
            metadata={"test": "value"},
            timestamp=datetime(2024, 1, 1, 12, 0, 0)
        )
        
        # Verify producer was called
        assert mock_producer.produce.called
        call_args = mock_producer.produce.call_args
        assert call_args[1]['topic'] == KafkaEventProducer.TOPIC_POLICY_DECISIONS
    
    @patch('caracal.kafka.producer.Producer')
    async def test_publish_agent_lifecycle(self, mock_producer_class, kafka_producer):
        """Test publishing an agent lifecycle event."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.produce = Mock()
        mock_producer.poll = Mock()
        mock_producer_class.return_value = mock_producer
        
        # Publish event
        await kafka_producer.publish_agent_lifecycle(
            agent_id="test-agent-123",
            lifecycle_event="created",
            metadata={"test": "value"},
            timestamp=datetime(2024, 1, 1, 12, 0, 0)
        )
        
        # Verify producer was called
        assert mock_producer.produce.called
        call_args = mock_producer.produce.call_args
        assert call_args[1]['topic'] == KafkaEventProducer.TOPIC_AGENT_LIFECYCLE
    
    @patch('caracal.kafka.producer.Producer')
    async def test_publish_policy_change(self, mock_producer_class, kafka_producer):
        """Test publishing a policy change event."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.produce = Mock()
        mock_producer.poll = Mock()
        mock_producer_class.return_value = mock_producer
        
        # Publish event
        await kafka_producer.publish_policy_change(
            agent_id="test-agent-123",
            policy_id="policy-123",
            change_type="modified",
            changed_by="admin",
            change_reason="Increased budget",
            metadata={"test": "value"},
            timestamp=datetime(2024, 1, 1, 12, 0, 0)
        )
        
        # Verify producer was called
        assert mock_producer.produce.called
        call_args = mock_producer.produce.call_args
        assert call_args[1]['topic'] == KafkaEventProducer.TOPIC_POLICY_CHANGES
    
    @patch('caracal.kafka.producer.Producer')
    async def test_retry_on_buffer_error(self, mock_producer_class, kafka_producer):
        """Test that producer retries on BufferError."""
        from confluent_kafka import BufferError as KafkaBufferError
        
        # Setup mock producer that fails first, then succeeds
        mock_producer = Mock()
        mock_producer.produce = Mock(side_effect=[
            KafkaBufferError("Queue full"),
            None  # Success on retry
        ])
        mock_producer.poll = Mock()
        mock_producer_class.return_value = mock_producer
        
        # Publish event - should succeed after retry
        await kafka_producer.publish_metering_event(
            agent_id="test-agent-123",
            resource_type="api_call",
            quantity=Decimal("1.0"),
            cost=Decimal("0.50")
        )
        
        # Verify producer was called twice (initial + 1 retry)
        assert mock_producer.produce.call_count == 2
    
    @patch('caracal.kafka.producer.Producer')
    async def test_flush(self, mock_producer_class, kafka_producer):
        """Test flushing pending messages."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.flush = Mock(return_value=0)  # 0 remaining messages
        mock_producer_class.return_value = mock_producer
        
        # Initialize producer
        kafka_producer._initialize()
        
        # Flush
        await kafka_producer.flush()
        
        # Verify flush was called
        assert mock_producer.flush.called
    
    @patch('caracal.kafka.producer.Producer')
    async def test_close(self, mock_producer_class, kafka_producer):
        """Test closing the producer."""
        # Setup mock producer
        mock_producer = Mock()
        mock_producer.flush = Mock(return_value=0)
        mock_producer_class.return_value = mock_producer
        
        # Initialize producer
        kafka_producer._initialize()
        
        # Close
        await kafka_producer.close()
        
        # Verify producer was flushed and cleared
        assert mock_producer.flush.called
        assert kafka_producer._producer is None
        assert kafka_producer._initialized is False
    
    def test_serialize_metadata(self, kafka_producer):
        """Test metadata serialization."""
        metadata = {
            "string": "value",
            "int": 123,
            "decimal": Decimal("1.5"),
            "bool": True
        }
        
        result = kafka_producer._serialize_metadata(metadata)
        
        # All values should be strings
        assert all(isinstance(v, str) for v in result.values())
        assert result["string"] == "value"
        assert result["int"] == "123"
        assert result["decimal"] == "1.5"
        assert result["bool"] == "True"
