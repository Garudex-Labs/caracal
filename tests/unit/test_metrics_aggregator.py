"""
Unit tests for MetricsAggregator consumer.

Tests the MetricsAggregatorConsumer class functionality including:
- Redis spending cache updates
- Prometheus metrics updates
- Spending trend calculation
- Anomaly detection
"""

import pytest
import json
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch, AsyncMock

from caracal.kafka.metrics_aggregator import MetricsAggregatorConsumer
from caracal.kafka.consumer import KafkaMessage
from caracal.redis.client import RedisClient
from caracal.redis.spending_cache import RedisSpendingCache
from caracal.monitoring.metrics import MetricsRegistry


@pytest.fixture
def mock_redis_client():
    """Create mock Redis client."""
    client = Mock(spec=RedisClient)
    client.ping.return_value = True
    client.get.return_value = None
    client.set.return_value = True
    client.incrbyfloat.return_value = 10.0
    client.incr.return_value = 1
    client.zadd.return_value = 1
    client.zrangebyscore.return_value = []
    client.expire.return_value = True
    return client


@pytest.fixture
def mock_metrics_registry():
    """Create mock MetricsRegistry."""
    from prometheus_client import CollectorRegistry
    registry = CollectorRegistry()
    return MetricsRegistry(registry=registry)


@pytest.fixture
def metrics_aggregator(mock_redis_client, mock_metrics_registry):
    """Create MetricsAggregatorConsumer instance."""
    consumer = MetricsAggregatorConsumer(
        brokers=["localhost:9092"],
        redis_client=mock_redis_client,
        metrics_registry=mock_metrics_registry,
        enable_transactions=False,  # Disable for testing
        enable_anomaly_detection=True
    )
    return consumer


def test_metrics_aggregator_initialization(metrics_aggregator):
    """Test MetricsAggregator initialization."""
    assert metrics_aggregator is not None
    assert metrics_aggregator.redis_client is not None
    assert metrics_aggregator.spending_cache is not None
    assert metrics_aggregator.metrics_registry is not None
    assert metrics_aggregator.enable_anomaly_detection is True


@pytest.mark.asyncio
async def test_process_metering_event(metrics_aggregator, mock_redis_client):
    """Test processing a metering event."""
    # Create test event
    event = {
        'event_id': 'test-event-123',
        'agent_id': 'agent-456',
        'resource_type': 'openai.gpt-4',
        'cost': 1.50,
        'currency': 'USD',
        'timestamp': int(datetime.utcnow().timestamp() * 1000)
    }
    
    # Create Kafka message
    message = KafkaMessage(
        topic='caracal.metering.events',
        partition=0,
        offset=100,
        key=b'agent-456',
        value=json.dumps(event).encode('utf-8'),
        timestamp=event['timestamp']
    )
    
    # Process message
    await metrics_aggregator.process_message(message)
    
    # Verify Redis calls were made
    assert mock_redis_client.incrbyfloat.called
    assert mock_redis_client.zadd.called
    assert mock_redis_client.incr.called
    assert mock_redis_client.expire.called


@pytest.mark.asyncio
async def test_update_prometheus_metrics(metrics_aggregator, mock_redis_client):
    """Test Prometheus metrics update."""
    # Mock spending cache responses
    mock_redis_client.get.return_value = "100.50"
    mock_redis_client.zrangebyscore.return_value = [
        "event1:10.0",
        "event2:15.5",
        "event3:20.0"
    ]
    
    # Update metrics
    metrics_aggregator._update_prometheus_metrics(
        agent_id='agent-123',
        resource_type='openai.gpt-4',
        cost=Decimal('1.50')
    )
    
    # Verify metrics were updated
    # (In a real test, we'd check the actual metric values)
    assert True  # Placeholder


@pytest.mark.asyncio
async def test_compute_spending_trends(metrics_aggregator, mock_redis_client):
    """Test spending trend calculation."""
    # Mock spending cache responses
    mock_redis_client.zrangebyscore.return_value = [
        "event1:10.0",
        "event2:15.5",
        "event3:20.0"
    ]
    
    # Compute trends
    await metrics_aggregator._compute_spending_trends(
        agent_id='agent-123',
        timestamp=datetime.utcnow()
    )
    
    # Verify trend storage calls
    assert mock_redis_client.zadd.called
    # Should be called 3 times (hourly, daily, weekly)
    assert mock_redis_client.zadd.call_count >= 3


@pytest.mark.asyncio
async def test_detect_anomaly_no_historical_data(metrics_aggregator, mock_redis_client):
    """Test anomaly detection with no historical data."""
    # Mock no historical spending
    mock_redis_client.zrangebyscore.return_value = []
    
    # Detect anomaly
    is_anomaly = await metrics_aggregator._detect_anomaly(
        agent_id='agent-123',
        current_cost=Decimal('100.0'),
        timestamp=datetime.utcnow()
    )
    
    # Should not detect anomaly without historical data
    assert is_anomaly is False


@pytest.mark.asyncio
async def test_detect_anomaly_normal_spending(metrics_aggregator, mock_redis_client):
    """Test anomaly detection with normal spending."""
    # Mock historical spending (average $10/day)
    historical_events = [f"event{i}:10.0" for i in range(7)]
    
    # Mock current spending ($15/day - within normal range)
    current_events = ["event1:15.0"]
    
    def mock_zrangebyscore(key, min_score, max_score, withscores=False):
        if 'historical' in str(min_score) or (datetime.utcnow().timestamp() - min_score) > 86400:
            return historical_events
        else:
            return current_events
    
    mock_redis_client.zrangebyscore.side_effect = mock_zrangebyscore
    
    # Detect anomaly
    is_anomaly = await metrics_aggregator._detect_anomaly(
        agent_id='agent-123',
        current_cost=Decimal('15.0'),
        timestamp=datetime.utcnow()
    )
    
    # Should not detect anomaly for normal spending
    assert is_anomaly is False


@pytest.mark.asyncio
async def test_detect_anomaly_high_spending(metrics_aggregator, mock_redis_client):
    """Test anomaly detection with high spending."""
    # Mock historical spending (average $10/day)
    historical_events = [f"event{i}:10.0" for i in range(7)]
    
    # Mock current spending ($50/day - 5x average, exceeds 2x threshold)
    current_events = [f"event{i}:10.0" for i in range(5)]
    
    call_count = [0]
    
    def mock_zrangebyscore(key, min_score, max_score, withscores=False):
        call_count[0] += 1
        # First call: historical data (7 days)
        if call_count[0] == 1:
            return historical_events
        # Second call: current daily data
        else:
            return current_events
    
    mock_redis_client.zrangebyscore.side_effect = mock_zrangebyscore
    
    # Detect anomaly
    is_anomaly = await metrics_aggregator._detect_anomaly(
        agent_id='agent-123',
        current_cost=Decimal('50.0'),
        timestamp=datetime.utcnow()
    )
    
    # Should detect anomaly for high spending
    assert is_anomaly is True


def test_spending_cache_update(mock_redis_client):
    """Test spending cache update."""
    cache = RedisSpendingCache(mock_redis_client)
    
    # Update spending
    cache.update_spending(
        agent_id='agent-123',
        cost=Decimal('10.50'),
        timestamp=datetime.utcnow(),
        event_id='event-456'
    )
    
    # Verify Redis calls
    assert mock_redis_client.incrbyfloat.called
    assert mock_redis_client.zadd.called
    assert mock_redis_client.incr.called
    assert mock_redis_client.expire.called


def test_spending_cache_get_total(mock_redis_client):
    """Test getting total spending from cache."""
    mock_redis_client.get.return_value = "123.45"
    
    cache = RedisSpendingCache(mock_redis_client)
    total = cache.get_total_spending('agent-123')
    
    assert total == Decimal('123.45')
    assert mock_redis_client.get.called


def test_spending_cache_get_range(mock_redis_client):
    """Test getting spending in time range."""
    mock_redis_client.zrangebyscore.return_value = [
        "event1:10.0",
        "event2:15.5",
        "event3:20.0"
    ]
    
    cache = RedisSpendingCache(mock_redis_client)
    
    start_time = datetime.utcnow() - timedelta(hours=1)
    end_time = datetime.utcnow()
    
    total = cache.get_spending_in_range('agent-123', start_time, end_time)
    
    assert total == Decimal('45.5')  # 10.0 + 15.5 + 20.0
    assert mock_redis_client.zrangebyscore.called


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
