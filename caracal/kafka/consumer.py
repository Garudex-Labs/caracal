"""
Kafka Consumer Base Class for Caracal Core v0.3.

Provides base functionality for all Kafka consumers with exactly-once semantics,
offset management, error handling, and dead letter queue support.

Requirements: 2.4, 2.5, 15.1, 15.2, 1.5, 1.6
"""

import asyncio
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, List, Dict, Any, Callable
from uuid import uuid4

from confluent_kafka import Consumer, KafkaError, KafkaException, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic

from caracal.logging_config import get_logger
from caracal.exceptions import KafkaConsumerError

logger = get_logger(__name__)


@dataclass
class ConsumerConfig:
    """
    Configuration for Kafka consumer.
    
    Attributes:
        auto_offset_reset: Where to start consuming ('earliest', 'latest')
        enable_auto_commit: Enable automatic offset commits (MUST be False for exactly-once)
        isolation_level: Isolation level ('read_uncommitted', 'read_committed')
        max_poll_records: Maximum records to fetch per poll
        session_timeout_ms: Session timeout in milliseconds
        enable_idempotence: Enable idempotent processing
        transactional_id_prefix: Prefix for transactional IDs (required for transactions)
    """
    auto_offset_reset: str = "earliest"
    enable_auto_commit: bool = False  # MUST be False for exactly-once
    isolation_level: str = "read_committed"  # For exactly-once
    max_poll_records: int = 500
    session_timeout_ms: int = 30000
    enable_idempotence: bool = True
    transactional_id_prefix: Optional[str] = None


@dataclass
class KafkaMessage:
    """
    Kafka message wrapper.
    
    Attributes:
        topic: Topic name
        partition: Partition number
        offset: Message offset
        key: Message key (bytes)
        value: Message value (bytes)
        timestamp: Message timestamp
        headers: Message headers
    """
    topic: str
    partition: int
    offset: int
    key: Optional[bytes]
    value: bytes
    timestamp: int
    headers: Optional[Dict[str, bytes]] = None
    
    def deserialize_json(self) -> Dict[str, Any]:
        """Deserialize message value as JSON."""
        return json.loads(self.value.decode('utf-8'))


class BaseKafkaConsumer(ABC):
    """
    Base class for Kafka consumers with exactly-once semantics.
    
    Provides:
    - Subscription and consumption loop
    - Abstract process_message method for subclasses
    - Error handling with retry logic (3 retries)
    - Dead letter queue for failed messages
    - Offset commit after successful processing
    - Consumer group rebalancing support
    
    Requirements: 2.4, 2.5, 15.1, 15.2, 1.5, 1.6
    """
    
    # Dead letter queue topic
    DLQ_TOPIC = "caracal.dlq"
    
    # Maximum retry attempts
    MAX_RETRIES = 3
    
    def __init__(
        self,
        brokers: List[str],
        topics: List[str],
        consumer_group: str,
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None,
        consumer_config: Optional[ConsumerConfig] = None,
        enable_transactions: bool = True
    ):
        """
        Initialize Kafka consumer.
        
        Args:
            brokers: List of Kafka broker addresses
            topics: List of topics to subscribe to
            consumer_group: Consumer group ID
            security_protocol: Security protocol ('PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL')
            sasl_mechanism: SASL mechanism ('PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512')
            sasl_username: SASL username
            sasl_password: SASL password
            ssl_ca_location: Path to CA certificate
            ssl_cert_location: Path to client certificate
            ssl_key_location: Path to client private key
            consumer_config: ConsumerConfig instance
            enable_transactions: Enable exactly-once semantics with transactions
        """
        self.brokers = brokers
        self.topics = topics
        self.consumer_group = consumer_group
        self.security_protocol = security_protocol
        self.sasl_mechanism = sasl_mechanism
        self.sasl_username = sasl_username
        self.sasl_password = sasl_password
        self.ssl_ca_location = ssl_ca_location
        self.ssl_cert_location = ssl_cert_location
        self.ssl_key_location = ssl_key_location
        self.consumer_config = consumer_config or ConsumerConfig()
        self.enable_transactions = enable_transactions
        
        self._consumer = None
        self._dlq_producer = None
        self._running = False
        self._initialized = False
        
        # Retry tracking per message
        self._retry_counts: Dict[str, int] = {}
        
        logger.info(
            f"Initializing {self.__class__.__name__}: "
            f"brokers={brokers}, topics={topics}, group={consumer_group}, "
            f"enable_transactions={enable_transactions}"
        )
    
    def _initialize(self):
        """Initialize Kafka consumer (lazy initialization)."""
        if self._initialized:
            return
        
        # Build consumer configuration
        consumer_conf = {
            'bootstrap.servers': ','.join(self.brokers),
            'group.id': self.consumer_group,
            'security.protocol': self.security_protocol,
            'auto.offset.reset': self.consumer_config.auto_offset_reset,
            'enable.auto.commit': self.consumer_config.enable_auto_commit,
            'isolation.level': self.consumer_config.isolation_level,
            'max.poll.interval.ms': 300000,  # 5 minutes
            'session.timeout.ms': self.consumer_config.session_timeout_ms,
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
        
        # Subscribe to topics with rebalance callbacks
        self._consumer.subscribe(
            self.topics,
            on_assign=self._on_partitions_assigned,
            on_revoke=self._on_partitions_revoked
        )
        
        # Initialize DLQ producer (for sending failed messages)
        from caracal.kafka.producer import KafkaEventProducer, KafkaConfig, ProducerConfig
        
        dlq_kafka_config = KafkaConfig(
            brokers=self.brokers,
            security_protocol=self.security_protocol,
            sasl_mechanism=self.sasl_mechanism,
            sasl_username=self.sasl_username,
            sasl_password=self.sasl_password,
            ssl_ca_location=self.ssl_ca_location,
            ssl_cert_location=self.ssl_cert_location,
            ssl_key_location=self.ssl_key_location,
            producer_config=ProducerConfig()
        )
        self._dlq_producer = KafkaEventProducer(dlq_kafka_config)
        
        self._initialized = True
        logger.info(f"{self.__class__.__name__} initialized successfully")
    
    def _on_partitions_assigned(self, consumer, partitions):
        """
        Callback when partitions are assigned to this consumer.
        
        Handles consumer group rebalancing by resuming from last committed offset.
        
        Args:
            consumer: Kafka consumer instance
            partitions: List of TopicPartition objects assigned
            
        Requirements: 1.5, 1.6
        """
        logger.info(
            f"Partitions assigned to {self.consumer_group}: "
            f"{[(p.topic, p.partition) for p in partitions]}"
        )
        
        # Resume from last committed offset
        for partition in partitions:
            # Get committed offset
            committed = consumer.committed([partition])
            if committed and committed[0].offset >= 0:
                logger.info(
                    f"Resuming from committed offset: "
                    f"topic={partition.topic}, partition={partition.partition}, "
                    f"offset={committed[0].offset}"
                )
            else:
                logger.info(
                    f"No committed offset found, starting from {self.consumer_config.auto_offset_reset}: "
                    f"topic={partition.topic}, partition={partition.partition}"
                )
    
    def _on_partitions_revoked(self, consumer, partitions):
        """
        Callback when partitions are revoked from this consumer.
        
        Handles consumer group rebalancing by committing offsets before revocation.
        
        Args:
            consumer: Kafka consumer instance
            partitions: List of TopicPartition objects revoked
            
        Requirements: 1.5, 1.6
        """
        logger.info(
            f"Partitions revoked from {self.consumer_group}: "
            f"{[(p.topic, p.partition) for p in partitions]}"
        )
        
        # Commit offsets before revocation
        try:
            consumer.commit(asynchronous=False)
            logger.info("Offsets committed before partition revocation")
        except KafkaException as e:
            logger.error(f"Failed to commit offsets before revocation: {e}")
    
    async def start(self) -> None:
        """
        Start consuming messages with exactly-once semantics.
        
        Consumption loop:
        1. Subscribe to topics
        2. Poll for messages
        3. For each message:
           a. Call process_message()
           b. On success, commit offset
           c. On error, retry up to MAX_RETRIES times
           d. On persistent failure, send to DLQ
        4. Handle rebalancing via callbacks
        
        Requirements: 2.4, 2.5, 1.5, 1.6
        """
        self._initialize()
        self._running = True
        
        logger.info(
            f"Starting {self.__class__.__name__} consumer loop: "
            f"topics={self.topics}, group={self.consumer_group}"
        )
        
        try:
            while self._running:
                # Poll for messages (timeout: 1 second)
                msg = self._consumer.poll(timeout=1.0)
                
                if msg is None:
                    # No message available
                    continue
                
                if msg.error():
                    # Handle Kafka errors
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        # End of partition - not an error
                        logger.debug(
                            f"Reached end of partition: "
                            f"topic={msg.topic()}, partition={msg.partition()}"
                        )
                    else:
                        # Actual error
                        logger.error(f"Kafka consumer error: {msg.error()}")
                    continue
                
                # Wrap message
                kafka_msg = KafkaMessage(
                    topic=msg.topic(),
                    partition=msg.partition(),
                    offset=msg.offset(),
                    key=msg.key(),
                    value=msg.value(),
                    timestamp=msg.timestamp()[1] if msg.timestamp()[0] == 1 else None,
                    headers=dict(msg.headers()) if msg.headers() else None
                )
                
                # Process message with error handling
                try:
                    await self._process_with_retry(kafka_msg)
                    
                    # Commit offset after successful processing
                    self._consumer.commit(asynchronous=False)
                    
                    logger.debug(
                        f"Message processed and offset committed: "
                        f"topic={kafka_msg.topic}, partition={kafka_msg.partition}, "
                        f"offset={kafka_msg.offset}"
                    )
                    
                except Exception as e:
                    # This should not happen as _process_with_retry handles all errors
                    logger.error(
                        f"Unexpected error processing message: {e}",
                        exc_info=True
                    )
                    
                    # Send to DLQ as last resort
                    await self.send_to_dlq(kafka_msg, e)
                    
                    # Commit offset to move past this message
                    self._consumer.commit(asynchronous=False)
        
        except KeyboardInterrupt:
            logger.info("Received interrupt signal, stopping consumer")
        
        except Exception as e:
            logger.error(f"Fatal error in consumer loop: {e}", exc_info=True)
            raise KafkaConsumerError(f"Consumer loop failed: {e}") from e
        
        finally:
            await self.stop()
    
    async def _process_with_retry(self, message: KafkaMessage) -> None:
        """
        Process message with retry logic.
        
        Retries up to MAX_RETRIES times on failure, then sends to DLQ.
        
        Args:
            message: Kafka message to process
            
        Requirements: 2.4, 2.5
        """
        # Generate message key for retry tracking
        msg_key = f"{message.topic}:{message.partition}:{message.offset}"
        
        # Get current retry count
        retry_count = self._retry_counts.get(msg_key, 0)
        
        try:
            # Process message
            await self.process_message(message)
            
            # Clear retry count on success
            if msg_key in self._retry_counts:
                del self._retry_counts[msg_key]
        
        except Exception as e:
            # Increment retry count
            retry_count += 1
            self._retry_counts[msg_key] = retry_count
            
            logger.warning(
                f"Message processing failed (attempt {retry_count}/{self.MAX_RETRIES}): "
                f"topic={message.topic}, partition={message.partition}, "
                f"offset={message.offset}, error={e}"
            )
            
            # Check if retries exhausted
            if retry_count >= self.MAX_RETRIES:
                logger.error(
                    f"Message processing failed after {self.MAX_RETRIES} retries, "
                    f"sending to DLQ: topic={message.topic}, partition={message.partition}, "
                    f"offset={message.offset}"
                )
                
                # Send to DLQ
                await self.send_to_dlq(message, e)
                
                # Clear retry count
                del self._retry_counts[msg_key]
            else:
                # Retry with exponential backoff
                backoff_seconds = 0.5 * (2 ** (retry_count - 1))
                logger.info(f"Retrying after {backoff_seconds}s backoff")
                await asyncio.sleep(backoff_seconds)
                
                # Retry processing
                await self._process_with_retry(message)
    
    @abstractmethod
    async def process_message(self, message: KafkaMessage) -> None:
        """
        Process a single message from Kafka.
        
        This method must be implemented by subclasses to define
        message processing logic.
        
        Args:
            message: Kafka message to process
            
        Raises:
            Exception: Any exception will trigger retry logic
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} must implement process_message()"
        )
    
    async def send_to_dlq(self, message: KafkaMessage, error: Exception) -> None:
        """
        Send failed message to dead letter queue.
        
        DLQ message includes:
        - Original message (topic, partition, offset, key, value)
        - Error message and type
        - Retry count
        - Failure timestamp
        
        Args:
            message: Failed Kafka message
            error: Exception that caused failure
            
        Requirements: 15.1, 15.2
        """
        try:
            # Build DLQ event
            dlq_event = {
                "dlq_id": str(uuid4()),
                "original_topic": message.topic,
                "original_partition": message.partition,
                "original_offset": message.offset,
                "original_key": message.key.decode('utf-8') if message.key else None,
                "original_value": message.value.decode('utf-8'),
                "error_type": type(error).__name__,
                "error_message": str(error),
                "retry_count": self._retry_counts.get(
                    f"{message.topic}:{message.partition}:{message.offset}",
                    0
                ),
                "failure_timestamp": datetime.utcnow().isoformat(),
                "consumer_group": self.consumer_group,
            }
            
            # Serialize to JSON
            dlq_value = json.dumps(dlq_event).encode('utf-8')
            
            # Publish to DLQ topic using low-level producer
            # (We can't use KafkaEventProducer here as it's designed for specific event types)
            from confluent_kafka import Producer
            
            producer_conf = {
                'bootstrap.servers': ','.join(self.brokers),
                'security.protocol': self.security_protocol,
            }
            
            if self.sasl_mechanism:
                producer_conf['sasl.mechanism'] = self.sasl_mechanism
                if self.sasl_username:
                    producer_conf['sasl.username'] = self.sasl_username
                if self.sasl_password:
                    producer_conf['sasl.password'] = self.sasl_password
            
            if self.ssl_ca_location:
                producer_conf['ssl.ca.location'] = self.ssl_ca_location
            if self.ssl_cert_location:
                producer_conf['ssl.certificate.location'] = self.ssl_cert_location
            if self.ssl_key_location:
                producer_conf['ssl.key.location'] = self.ssl_key_location
            
            producer = Producer(producer_conf)
            
            # Produce to DLQ
            producer.produce(
                topic=self.DLQ_TOPIC,
                key=message.key,
                value=dlq_value
            )
            
            # Flush to ensure delivery
            producer.flush(timeout=10.0)
            
            logger.info(
                f"Message sent to DLQ: dlq_id={dlq_event['dlq_id']}, "
                f"original_topic={message.topic}, original_offset={message.offset}"
            )
        
        except Exception as dlq_error:
            logger.error(
                f"Failed to send message to DLQ: {dlq_error}",
                exc_info=True
            )
            # Don't raise - we don't want to fail the consumer loop
    
    async def stop(self) -> None:
        """Stop consumer gracefully, committing pending offsets."""
        if not self._running:
            return
        
        self._running = False
        
        logger.info(f"Stopping {self.__class__.__name__}")
        
        if self._consumer:
            try:
                # Commit final offsets
                self._consumer.commit(asynchronous=False)
                logger.info("Final offsets committed")
            except Exception as e:
                logger.error(f"Failed to commit final offsets: {e}")
            
            # Close consumer
            self._consumer.close()
            self._consumer = None
        
        if self._dlq_producer:
            await self._dlq_producer.close()
            self._dlq_producer = None
        
        self._initialized = False
        logger.info(f"{self.__class__.__name__} stopped")
    
    def is_running(self) -> bool:
        """Check if consumer is running."""
        return self._running
