"""
Dead Letter Queue Handler for Caracal Core v0.3.

Provides functionality for sending failed events to the dead letter queue
and monitoring DLQ events.

Requirements: 15.1, 15.2, 15.4
"""

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Dict, Any, List
from uuid import uuid4

from confluent_kafka import Producer, Consumer, KafkaError

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class DLQEvent:
    """
    Dead Letter Queue event.
    
    Attributes:
        dlq_id: Unique identifier for DLQ event
        original_topic: Original Kafka topic
        original_partition: Original partition number
        original_offset: Original message offset
        original_key: Original message key
        original_value: Original message value
        error_type: Type of error that caused failure
        error_message: Error message
        retry_count: Number of retry attempts
        failure_timestamp: Timestamp when failure occurred
        consumer_group: Consumer group that failed to process
    """
    dlq_id: str
    original_topic: str
    original_partition: int
    original_offset: int
    original_key: Optional[str]
    original_value: str
    error_type: str
    error_message: str
    retry_count: int
    failure_timestamp: str
    consumer_group: str
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert DLQ event to dictionary."""
        return {
            "dlq_id": self.dlq_id,
            "original_topic": self.original_topic,
            "original_partition": self.original_partition,
            "original_offset": self.original_offset,
            "original_key": self.original_key,
            "original_value": self.original_value,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "retry_count": self.retry_count,
            "failure_timestamp": self.failure_timestamp,
            "consumer_group": self.consumer_group,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'DLQEvent':
        """Create DLQ event from dictionary."""
        return cls(
            dlq_id=data["dlq_id"],
            original_topic=data["original_topic"],
            original_partition=data["original_partition"],
            original_offset=data["original_offset"],
            original_key=data.get("original_key"),
            original_value=data["original_value"],
            error_type=data["error_type"],
            error_message=data["error_message"],
            retry_count=data["retry_count"],
            failure_timestamp=data["failure_timestamp"],
            consumer_group=data["consumer_group"],
        )


class DLQHandler:
    """
    Handler for dead letter queue operations.
    
    Provides functionality to send failed events to DLQ with complete metadata
    including original event, error details, retry count, and failure timestamp.
    
    Requirements: 15.1, 15.2
    """
    
    # Dead letter queue topic name
    DLQ_TOPIC = "caracal.dlq"
    
    def __init__(
        self,
        brokers: List[str],
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None,
    ):
        """
        Initialize DLQ handler.
        
        Args:
            brokers: List of Kafka broker addresses
            security_protocol: Security protocol ('PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL')
            sasl_mechanism: SASL mechanism ('PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512')
            sasl_username: SASL username
            sasl_password: SASL password
            ssl_ca_location: Path to CA certificate
            ssl_cert_location: Path to client certificate
            ssl_key_location: Path to client private key
        """
        self.brokers = brokers
        self.security_protocol = security_protocol
        self.sasl_mechanism = sasl_mechanism
        self.sasl_username = sasl_username
        self.sasl_password = sasl_password
        self.ssl_ca_location = ssl_ca_location
        self.ssl_cert_location = ssl_cert_location
        self.ssl_key_location = ssl_key_location
        
        self._producer = None
        
        logger.info(f"Initialized DLQHandler: brokers={brokers}")
    
    def _get_producer(self) -> Producer:
        """Get or create Kafka producer for DLQ."""
        if self._producer is None:
            # Build producer configuration
            producer_conf = {
                'bootstrap.servers': ','.join(self.brokers),
                'security.protocol': self.security_protocol,
            }
            
            # Add SASL configuration if provided
            if self.sasl_mechanism:
                producer_conf['sasl.mechanism'] = self.sasl_mechanism
                if self.sasl_username:
                    producer_conf['sasl.username'] = self.sasl_username
                if self.sasl_password:
                    producer_conf['sasl.password'] = self.sasl_password
            
            # Add SSL configuration if provided
            if self.ssl_ca_location:
                producer_conf['ssl.ca.location'] = self.ssl_ca_location
            if self.ssl_cert_location:
                producer_conf['ssl.certificate.location'] = self.ssl_cert_location
            if self.ssl_key_location:
                producer_conf['ssl.key.location'] = self.ssl_key_location
            
            self._producer = Producer(producer_conf)
            logger.debug("Created Kafka producer for DLQ")
        
        return self._producer
    
    def send_to_dlq(
        self,
        original_topic: str,
        original_partition: int,
        original_offset: int,
        original_key: Optional[bytes],
        original_value: bytes,
        error: Exception,
        retry_count: int,
        consumer_group: str,
    ) -> str:
        """
        Send failed message to dead letter queue.
        
        Creates a DLQ event with complete metadata including:
        - Original message (topic, partition, offset, key, value)
        - Error details (type, message)
        - Retry count
        - Failure timestamp
        - Consumer group
        
        Args:
            original_topic: Original Kafka topic
            original_partition: Original partition number
            original_offset: Original message offset
            original_key: Original message key (bytes)
            original_value: Original message value (bytes)
            error: Exception that caused failure
            retry_count: Number of retry attempts
            consumer_group: Consumer group that failed to process
            
        Returns:
            DLQ event ID
            
        Raises:
            Exception: If DLQ publishing fails
            
        Requirements: 15.1, 15.2
        """
        try:
            # Generate unique DLQ ID
            dlq_id = str(uuid4())
            
            # Build DLQ event
            dlq_event = DLQEvent(
                dlq_id=dlq_id,
                original_topic=original_topic,
                original_partition=original_partition,
                original_offset=original_offset,
                original_key=original_key.decode('utf-8') if original_key else None,
                original_value=original_value.decode('utf-8'),
                error_type=type(error).__name__,
                error_message=str(error),
                retry_count=retry_count,
                failure_timestamp=datetime.utcnow().isoformat(),
                consumer_group=consumer_group,
            )
            
            # Serialize to JSON
            dlq_value = json.dumps(dlq_event.to_dict()).encode('utf-8')
            
            # Get producer
            producer = self._get_producer()
            
            # Produce to DLQ
            producer.produce(
                topic=self.DLQ_TOPIC,
                key=original_key,
                value=dlq_value,
            )
            
            # Flush to ensure delivery
            producer.flush(timeout=10.0)
            
            logger.info(
                f"Message sent to DLQ: dlq_id={dlq_id}, "
                f"original_topic={original_topic}, original_offset={original_offset}, "
                f"error_type={dlq_event.error_type}"
            )
            
            return dlq_id
        
        except Exception as dlq_error:
            logger.error(
                f"Failed to send message to DLQ: {dlq_error}",
                exc_info=True
            )
            raise
    
    def close(self):
        """Close DLQ handler and flush pending messages."""
        if self._producer:
            self._producer.flush(timeout=10.0)
            self._producer = None
            logger.debug("Closed DLQ handler")


class DLQMonitorConsumer:
    """
    Consumer for monitoring dead letter queue events.
    
    Subscribes to caracal.dlq topic, logs all DLQ events, and alerts
    when DLQ size exceeds threshold.
    
    Requirements: 15.4
    """
    
    # DLQ size threshold for alerting
    DLQ_SIZE_THRESHOLD = 1000
    
    def __init__(
        self,
        brokers: List[str],
        consumer_group: str = "dlq-monitor-group",
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None,
        alert_threshold: int = DLQ_SIZE_THRESHOLD,
    ):
        """
        Initialize DLQ monitor consumer.
        
        Args:
            brokers: List of Kafka broker addresses
            consumer_group: Consumer group ID
            security_protocol: Security protocol
            sasl_mechanism: SASL mechanism
            sasl_username: SASL username
            sasl_password: SASL password
            ssl_ca_location: Path to CA certificate
            ssl_cert_location: Path to client certificate
            ssl_key_location: Path to client private key
            alert_threshold: DLQ size threshold for alerting (default: 1000)
        """
        self.brokers = brokers
        self.consumer_group = consumer_group
        self.security_protocol = security_protocol
        self.sasl_mechanism = sasl_mechanism
        self.sasl_username = sasl_username
        self.sasl_password = sasl_password
        self.ssl_ca_location = ssl_ca_location
        self.ssl_cert_location = ssl_cert_location
        self.ssl_key_location = ssl_key_location
        self.alert_threshold = alert_threshold
        
        self._consumer = None
        self._running = False
        self._dlq_event_count = 0
        self._last_alert_count = 0
        
        logger.info(
            f"Initialized DLQMonitorConsumer: brokers={brokers}, "
            f"group={consumer_group}, alert_threshold={alert_threshold}"
        )
    
    def _initialize(self):
        """Initialize Kafka consumer."""
        if self._consumer is not None:
            return
        
        # Build consumer configuration
        consumer_conf = {
            'bootstrap.servers': ','.join(self.brokers),
            'group.id': self.consumer_group,
            'security.protocol': self.security_protocol,
            'auto.offset.reset': 'earliest',
            'enable.auto.commit': True,
        }
        
        # Add SASL configuration if provided
        if self.sasl_mechanism:
            consumer_conf['sasl.mechanism'] = self.sasl_mechanism
            if self.sasl_username:
                consumer_conf['sasl.username'] = self.sasl_username
            if self.sasl_password:
                consumer_conf['sasl.password'] = self.sasl_password
        
        # Add SSL configuration if provided
        if self.ssl_ca_location:
            consumer_conf['ssl.ca.location'] = self.ssl_ca_location
        if self.ssl_cert_location:
            consumer_conf['ssl.certificate.location'] = self.ssl_cert_location
        if self.ssl_key_location:
            consumer_conf['ssl.key.location'] = self.ssl_key_location
        
        # Create consumer
        self._consumer = Consumer(consumer_conf)
        
        # Subscribe to DLQ topic
        self._consumer.subscribe([DLQHandler.DLQ_TOPIC])
        
        logger.info(f"DLQ monitor consumer subscribed to {DLQHandler.DLQ_TOPIC}")
    
    def start(self):
        """
        Start monitoring DLQ events.
        
        Subscribes to caracal.dlq topic, logs all events, and alerts
        when DLQ size exceeds threshold.
        
        Requirements: 15.4
        """
        self._initialize()
        self._running = True
        
        logger.info("Starting DLQ monitor consumer")
        
        try:
            while self._running:
                # Poll for messages (timeout: 1 second)
                msg = self._consumer.poll(timeout=1.0)
                
                if msg is None:
                    continue
                
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        # End of partition - not an error
                        continue
                    else:
                        logger.error(f"Kafka consumer error: {msg.error()}")
                        continue
                
                # Process DLQ event
                try:
                    # Deserialize DLQ event
                    dlq_data = json.loads(msg.value().decode('utf-8'))
                    dlq_event = DLQEvent.from_dict(dlq_data)
                    
                    # Log DLQ event
                    logger.warning(
                        f"DLQ Event: dlq_id={dlq_event.dlq_id}, "
                        f"original_topic={dlq_event.original_topic}, "
                        f"original_offset={dlq_event.original_offset}, "
                        f"error_type={dlq_event.error_type}, "
                        f"error_message={dlq_event.error_message}, "
                        f"retry_count={dlq_event.retry_count}, "
                        f"consumer_group={dlq_event.consumer_group}"
                    )
                    
                    # Increment DLQ event count
                    self._dlq_event_count += 1
                    
                    # Check if threshold exceeded
                    if (self._dlq_event_count >= self.alert_threshold and
                        self._dlq_event_count > self._last_alert_count):
                        
                        logger.error(
                            f"ALERT: DLQ size exceeded threshold! "
                            f"Current size: {self._dlq_event_count}, "
                            f"Threshold: {self.alert_threshold}"
                        )
                        
                        # Update last alert count to avoid repeated alerts
                        self._last_alert_count = self._dlq_event_count
                
                except Exception as e:
                    logger.error(
                        f"Failed to process DLQ event: {e}",
                        exc_info=True
                    )
        
        except KeyboardInterrupt:
            logger.info("Received interrupt signal, stopping DLQ monitor")
        
        except Exception as e:
            logger.error(f"Fatal error in DLQ monitor: {e}", exc_info=True)
            raise
        
        finally:
            self.stop()
    
    def stop(self):
        """Stop DLQ monitor consumer."""
        if not self._running:
            return
        
        self._running = False
        
        logger.info("Stopping DLQ monitor consumer")
        
        if self._consumer:
            self._consumer.close()
            self._consumer = None
        
        logger.info(
            f"DLQ monitor stopped. Total DLQ events processed: {self._dlq_event_count}"
        )
    
    def get_dlq_event_count(self) -> int:
        """Get current DLQ event count."""
        return self._dlq_event_count
    
    def is_running(self) -> bool:
        """Check if monitor is running."""
        return self._running


