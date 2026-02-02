"""
MetricsAggregator Consumer for Caracal Core v0.3.

Consumes metering events from Kafka and updates real-time metrics in Redis
and Prometheus. Computes spending trends and detects anomalies.

Requirements: 2.2, 16.2, 16.3, 16.4, 16.5, 16.6
"""

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any

from caracal.kafka.consumer import BaseKafkaConsumer, KafkaMessage, ConsumerConfig
from caracal.redis.client import RedisClient
from caracal.redis.spending_cache import RedisSpendingCache
from caracal.monitoring.metrics import MetricsRegistry
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MetricsAggregatorConsumer(BaseKafkaConsumer):
    """
    Kafka consumer for aggregating metrics from metering events.
    
    Subscribes to caracal.metering.events and:
    - Updates Redis spending cache
    - Updates Prometheus metrics (spending rate, event count)
    - Computes spending trends (hourly, daily, weekly)
    - Detects spending anomalies (spending > 2x average)
    - Publishes alert events when anomalies detected
    
    Requirements: 2.2, 16.2, 16.3, 16.4, 16.5, 16.6
    """
    
    # Topic to subscribe to
    TOPIC_METERING = "caracal.metering.events"
    
    # Consumer group
    CONSUMER_GROUP = "metrics-aggregator-group"
    
    # Anomaly detection threshold (2x average)
    ANOMALY_THRESHOLD_MULTIPLIER = 2.0
    
    # Historical window for anomaly detection (7 days)
    ANOMALY_HISTORICAL_WINDOW_DAYS = 7
    
    def __init__(
        self,
        brokers: List[str],
        redis_client: RedisClient,
        metrics_registry: MetricsRegistry,
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None,
        consumer_config: Optional[ConsumerConfig] = None,
        enable_transactions: bool = True,
        enable_anomaly_detection: bool = True
    ):
        """
        Initialize MetricsAggregator consumer.
        
        Args:
            brokers: List of Kafka broker addresses
            redis_client: RedisClient instance for caching
            metrics_registry: MetricsRegistry instance for Prometheus metrics
            security_protocol: Security protocol for Kafka
            sasl_mechanism: SASL mechanism for Kafka
            sasl_username: SASL username for Kafka
            sasl_password: SASL password for Kafka
            ssl_ca_location: Path to CA certificate
            ssl_cert_location: Path to client certificate
            ssl_key_location: Path to client private key
            consumer_config: ConsumerConfig instance
            enable_transactions: Enable exactly-once semantics
            enable_anomaly_detection: Enable anomaly detection
        """
        super().__init__(
            brokers=brokers,
            topics=[self.TOPIC_METERING],
            consumer_group=self.CONSUMER_GROUP,
            security_protocol=security_protocol,
            sasl_mechanism=sasl_mechanism,
            sasl_username=sasl_username,
            sasl_password=sasl_password,
            ssl_ca_location=ssl_ca_location,
            ssl_cert_location=ssl_cert_location,
            ssl_key_location=ssl_key_location,
            consumer_config=consumer_config,
            enable_transactions=enable_transactions
        )
        
        self.redis_client = redis_client
        self.spending_cache = RedisSpendingCache(redis_client)
        self.metrics_registry = metrics_registry
        self.enable_anomaly_detection = enable_anomaly_detection
        
        # Initialize Prometheus metrics for v0.3
        self._initialize_v03_metrics()
        
        logger.info(
            f"MetricsAggregatorConsumer initialized: "
            f"brokers={brokers}, enable_anomaly_detection={enable_anomaly_detection}"
        )
    
    def _initialize_v03_metrics(self):
        """Initialize v0.3-specific Prometheus metrics."""
        from prometheus_client import Counter, Gauge, Histogram
        
        # Spending metrics
        self.spending_rate_gauge = Gauge(
            'caracal_spending_rate_usd_per_hour',
            'Current spending rate in USD per hour',
            ['agent_id'],
            registry=self.metrics_registry.registry
        )
        
        self.total_spending_gauge = Gauge(
            'caracal_total_spending_usd',
            'Total spending in USD',
            ['agent_id'],
            registry=self.metrics_registry.registry
        )
        
        # Event count metrics
        self.event_count_total = Counter(
            'caracal_metering_events_processed_total',
            'Total number of metering events processed',
            ['agent_id', 'resource_type'],
            registry=self.metrics_registry.registry
        )
        
        # Anomaly detection metrics
        self.anomalies_detected_total = Counter(
            'caracal_spending_anomalies_detected_total',
            'Total number of spending anomalies detected',
            ['agent_id'],
            registry=self.metrics_registry.registry
        )
        
        # Consumer lag metrics
        self.consumer_lag_gauge = Gauge(
            'caracal_metrics_aggregator_consumer_lag',
            'Consumer lag in number of messages',
            ['partition'],
            registry=self.metrics_registry.registry
        )
        
        logger.info("v0.3 Prometheus metrics initialized")
    
    async def process_message(self, message: KafkaMessage) -> None:
        """
        Process metering event from Kafka.
        
        Steps:
        1. Deserialize event
        2. Update Redis spending cache
        3. Update Prometheus metrics (spending rate, event count)
        4. Compute spending trends (hourly, daily, weekly)
        5. Detect anomalies (spending > 2x average)
        6. If anomaly detected, publish alert event
        
        Args:
            message: Kafka message containing metering event
            
        Requirements: 2.2, 16.2, 16.3, 16.4, 16.5, 16.6
        """
        try:
            # Deserialize event
            event = message.deserialize_json()
            
            # Extract event fields
            event_id = event.get('event_id')
            agent_id = event.get('agent_id')
            resource_type = event.get('resource_type')
            cost = Decimal(str(event.get('cost', 0)))
            currency = event.get('currency', 'USD')
            timestamp_ms = event.get('timestamp')
            
            # Convert timestamp from milliseconds to datetime
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)
            
            logger.debug(
                f"Processing metering event: event_id={event_id}, "
                f"agent_id={agent_id}, resource={resource_type}, cost={cost}"
            )
            
            # Update Redis spending cache
            self.spending_cache.update_spending(
                agent_id=agent_id,
                cost=cost,
                timestamp=timestamp,
                event_id=event_id
            )
            
            # Update Prometheus metrics
            self._update_prometheus_metrics(
                agent_id=agent_id,
                resource_type=resource_type,
                cost=cost
            )
            
            # Compute spending trends
            await self._compute_spending_trends(agent_id, timestamp)
            
            # Detect anomalies
            if self.enable_anomaly_detection:
                await self._detect_anomaly(agent_id, cost, timestamp)
            
            logger.debug(
                f"Metering event processed successfully: event_id={event_id}"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to process metering event: {e}",
                exc_info=True
            )
            raise
    
    def _update_prometheus_metrics(
        self,
        agent_id: str,
        resource_type: str,
        cost: Decimal
    ) -> None:
        """
        Update Prometheus metrics.
        
        Updates:
        - Event count (counter)
        - Total spending (gauge)
        - Spending rate (gauge, calculated from recent spending)
        
        Args:
            agent_id: Agent identifier
            resource_type: Resource type
            cost: Event cost
            
        Requirements: 16.2, 16.3
        """
        try:
            # Increment event count
            self.event_count_total.labels(
                agent_id=agent_id,
                resource_type=resource_type
            ).inc()
            
            # Update total spending
            total_spending = self.spending_cache.get_total_spending(agent_id)
            if total_spending is not None:
                self.total_spending_gauge.labels(agent_id=agent_id).set(
                    float(total_spending)
                )
            
            # Calculate spending rate (last hour)
            now = datetime.utcnow()
            one_hour_ago = now - timedelta(hours=1)
            hourly_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=one_hour_ago,
                end_time=now
            )
            
            # Set spending rate (USD per hour)
            self.spending_rate_gauge.labels(agent_id=agent_id).set(
                float(hourly_spending)
            )
            
            logger.debug(
                f"Updated Prometheus metrics: agent_id={agent_id}, "
                f"total={total_spending}, rate={hourly_spending}/hr"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to update Prometheus metrics for agent {agent_id}: {e}",
                exc_info=True
            )
            # Don't raise - metrics failures shouldn't break the consumer
    
    async def _compute_spending_trends(
        self,
        agent_id: str,
        timestamp: datetime
    ) -> None:
        """
        Compute spending trends for agent.
        
        Computes and stores:
        - Hourly spending trend
        - Daily spending trend
        - Weekly spending trend
        
        Args:
            agent_id: Agent identifier
            timestamp: Current timestamp
            
        Requirements: 16.4
        """
        try:
            now = datetime.utcnow()
            
            # Compute hourly trend (last hour)
            one_hour_ago = now - timedelta(hours=1)
            hourly_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=one_hour_ago,
                end_time=now
            )
            self.spending_cache.store_spending_trend(
                agent_id=agent_id,
                window='hourly',
                timestamp=now,
                spending=hourly_spending
            )
            
            # Compute daily trend (last 24 hours)
            one_day_ago = now - timedelta(days=1)
            daily_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=one_day_ago,
                end_time=now
            )
            self.spending_cache.store_spending_trend(
                agent_id=agent_id,
                window='daily',
                timestamp=now,
                spending=daily_spending
            )
            
            # Compute weekly trend (last 7 days)
            one_week_ago = now - timedelta(days=7)
            weekly_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=one_week_ago,
                end_time=now
            )
            self.spending_cache.store_spending_trend(
                agent_id=agent_id,
                window='weekly',
                timestamp=now,
                spending=weekly_spending
            )
            
            logger.debug(
                f"Computed spending trends: agent_id={agent_id}, "
                f"hourly={hourly_spending}, daily={daily_spending}, "
                f"weekly={weekly_spending}"
            )
        
        except Exception as e:
            logger.error(
                f"Failed to compute spending trends for agent {agent_id}: {e}",
                exc_info=True
            )
            # Don't raise - trend computation failures shouldn't break the consumer
    
    async def _detect_anomaly(
        self,
        agent_id: str,
        current_cost: Decimal,
        timestamp: datetime
    ) -> bool:
        """
        Detect spending anomaly for agent.
        
        Anomaly detection logic:
        1. Calculate average spending from historical data (last 7 days)
        2. Compare current spending to average
        3. If current > 2x average, detect anomaly
        4. Publish alert event
        
        Args:
            agent_id: Agent identifier
            current_cost: Current event cost
            timestamp: Current timestamp
            
        Returns:
            True if anomaly detected, False otherwise
            
        Requirements: 16.5, 16.6
        """
        try:
            # Get historical spending (last 7 days)
            now = datetime.utcnow()
            historical_start = now - timedelta(days=self.ANOMALY_HISTORICAL_WINDOW_DAYS)
            
            historical_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=historical_start,
                end_time=now
            )
            
            # Calculate average daily spending
            if historical_spending > 0:
                average_daily_spending = historical_spending / Decimal(
                    self.ANOMALY_HISTORICAL_WINDOW_DAYS
                )
            else:
                # No historical data - can't detect anomaly
                return False
            
            # Get current daily spending
            one_day_ago = now - timedelta(days=1)
            current_daily_spending = self.spending_cache.get_spending_in_range(
                agent_id=agent_id,
                start_time=one_day_ago,
                end_time=now
            )
            
            # Check if current spending > 2x average
            threshold = average_daily_spending * Decimal(self.ANOMALY_THRESHOLD_MULTIPLIER)
            
            if current_daily_spending > threshold:
                # Anomaly detected!
                logger.warning(
                    f"Spending anomaly detected: agent_id={agent_id}, "
                    f"current_daily={current_daily_spending}, "
                    f"average_daily={average_daily_spending}, "
                    f"threshold={threshold}"
                )
                
                # Update Prometheus metric
                self.anomalies_detected_total.labels(agent_id=agent_id).inc()
                
                # Publish alert event
                await self._publish_alert_event(
                    agent_id=agent_id,
                    current_spending=current_daily_spending,
                    average_spending=average_daily_spending,
                    threshold=threshold,
                    timestamp=timestamp
                )
                
                return True
            
            return False
        
        except Exception as e:
            logger.error(
                f"Failed to detect anomaly for agent {agent_id}: {e}",
                exc_info=True
            )
            return False
    
    async def _publish_alert_event(
        self,
        agent_id: str,
        current_spending: Decimal,
        average_spending: Decimal,
        threshold: Decimal,
        timestamp: datetime
    ) -> None:
        """
        Publish alert event for spending anomaly.
        
        Note: In a full implementation, this would publish to a Kafka topic
        or send notifications via email/Slack/PagerDuty. For now, we just log.
        
        Args:
            agent_id: Agent identifier
            current_spending: Current daily spending
            average_spending: Average daily spending
            threshold: Anomaly threshold
            timestamp: Alert timestamp
            
        Requirements: 16.6
        """
        try:
            alert = {
                'alert_type': 'spending_anomaly',
                'agent_id': agent_id,
                'current_spending': float(current_spending),
                'average_spending': float(average_spending),
                'threshold': float(threshold),
                'multiplier': self.ANOMALY_THRESHOLD_MULTIPLIER,
                'timestamp': timestamp.isoformat(),
                'severity': 'warning',
                'message': (
                    f"Agent {agent_id} spending anomaly: "
                    f"current daily spending ${current_spending:.2f} exceeds "
                    f"{self.ANOMALY_THRESHOLD_MULTIPLIER}x average "
                    f"(${average_spending:.2f})"
                )
            }
            
            # TODO: Publish to Kafka alert topic or send notification
            # For now, just log the alert
            logger.warning(
                f"ALERT: {alert['message']}",
                extra={'alert': alert}
            )
        
        except Exception as e:
            logger.error(
                f"Failed to publish alert event for agent {agent_id}: {e}",
                exc_info=True
            )
