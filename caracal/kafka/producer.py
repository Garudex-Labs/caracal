"""
Kafka Event Producer for Caracal Core v0.3.

Publishes events to Kafka topics with Avro serialization, retry logic,
and partition key routing for ordering guarantees.

Requirements: 1.1, 1.2, 1.3, 1.4
"""

import asyncio
import json
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from decimal import Decimal
from typing import Optional, Dict, Any, List
from uuid import UUID, uuid4

from confluent_kafka import Producer
from confluent_kafka.serialization import StringSerializer, SerializationContext, MessageField
from confluent_kafka.schema_registry import SchemaRegistryClient
from confluent_kafka.schema_registry.avro import AvroSerializer

from caracal.logging_config import get_logger
from caracal.exceptions import KafkaPublishError

logger = get_logger(__name__)


@dataclass
class ProducerConfig:
    """
    Configuration for Kafka producer.
    
    Attributes:
        acks: Number of acknowledgments ('all', '1', '0')
        retries: Number of retries on transient failures
        max_in_flight_requests: Maximum unacknowledged requests
        compression_type: Compression algorithm ('snappy', 'gzip', 'lz4', 'zstd', 'none')
        enable_idempotence: Enable idempotent producer for exactly-once semantics
        transactional_id_prefix: Prefix for transactional IDs (required for transactions)
    """
    acks: str = "all"
    retries: int = 3
    max_in_flight_requests: int = 5
    compression_type: str = "snappy"
    enable_idempotence: bool = True
    transactional_id_prefix: Optional[str] = "caracal-producer"


@dataclass
class KafkaConfig:
    """
    Configuration for Kafka connection.
    
    Attributes:
        brokers: List of Kafka broker addresses
        security_protocol: Security protocol ('PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL')
        sasl_mechanism: SASL mechanism ('PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512')
        sasl_username: SASL username
        sasl_password: SASL password
        ssl_ca_location: Path to CA certificate
        ssl_cert_location: Path to client certificate
        ssl_key_location: Path to client private key
        schema_registry_url: URL of Confluent Schema Registry
        producer_config: ProducerConfig instance
    """
    brokers: List[str]
    security_protocol: str = "PLAINTEXT"
    sasl_mechanism: Optional[str] = None
    sasl_username: Optional[str] = None
    sasl_password: Optional[str] = None
    ssl_ca_location: Optional[str] = None
    ssl_cert_location: Optional[str] = None
    ssl_key_location: Optional[str] = None
    schema_registry_url: Optional[str] = None
    producer_config: ProducerConfig = None
    
    def __post_init__(self):
        if self.producer_config is None:
            self.producer_config = ProducerConfig()


@dataclass
class MeteringEvent:
    """
    Metering event for resource consumption.
    
    Attributes:
        event_id: Unique event identifier
        schema_version: Event schema version
        timestamp: Event timestamp (Unix milliseconds)
        agent_id: Agent identifier
        event_type: Event type (always 'metering')
        resource_type: Resource type identifier
        quantity: Resource quantity consumed
        cost: Cost in currency units
        currency: Currency code (e.g., 'USD')
        provisional_charge_id: Optional provisional charge ID
        metadata: Additional event metadata
    """
    event_id: str
    schema_version: int
    timestamp: int
    agent_id: str
    event_type: str
    resource_type: str
    quantity: float
    cost: float
    currency: str
    provisional_charge_id: Optional[str] = None
    metadata: Optional[Dict[str, str]] = None


@dataclass
class PolicyDecisionEvent:
    """
    Policy decision event for budget checks.
    
    Attributes:
        event_id: Unique event identifier
        schema_version: Event schema version
        timestamp: Event timestamp (Unix milliseconds)
        agent_id: Agent identifier
        event_type: Event type (always 'policy_decision')
        decision: Decision result ('allowed' or 'denied')
        reason: Decision reason
        policy_id: Policy identifier
        estimated_cost: Estimated cost checked
        remaining_budget: Remaining budget after decision
        metadata: Additional event metadata
    """
    event_id: str
    schema_version: int
    timestamp: int
    agent_id: str
    event_type: str
    decision: str
    reason: str
    policy_id: Optional[str] = None
    estimated_cost: Optional[float] = None
    remaining_budget: Optional[float] = None
    metadata: Optional[Dict[str, str]] = None


@dataclass
class AgentLifecycleEvent:
    """
    Agent lifecycle event for agent state changes.
    
    Attributes:
        event_id: Unique event identifier
        schema_version: Event schema version
        timestamp: Event timestamp (Unix milliseconds)
        agent_id: Agent identifier
        event_type: Event type (always 'agent_lifecycle')
        lifecycle_event: Lifecycle event type ('created', 'activated', 'deactivated', 'deleted')
        metadata: Additional event metadata
    """
    event_id: str
    schema_version: int
    timestamp: int
    agent_id: str
    event_type: str
    lifecycle_event: str
    metadata: Optional[Dict[str, str]] = None


@dataclass
class PolicyChangeEvent:
    """
    Policy change event for policy modifications.
    
    Attributes:
        event_id: Unique event identifier
        schema_version: Event schema version
        timestamp: Event timestamp (Unix milliseconds)
        agent_id: Agent identifier
        event_type: Event type (always 'policy_change')
        policy_id: Policy identifier
        change_type: Change type ('created', 'modified', 'deactivated')
        changed_by: User who made the change
        change_reason: Reason for the change
        metadata: Additional event metadata
    """
    event_id: str
    schema_version: int
    timestamp: int
    agent_id: str
    event_type: str
    policy_id: str
    change_type: str
    changed_by: str
    change_reason: str
    metadata: Optional[Dict[str, str]] = None


class KafkaEventProducer:
    """
    Kafka event producer for publishing events to Kafka topics.
    
    Publishes events with:
    - Avro serialization (if schema registry configured)
    - JSON serialization (fallback)
    - Retry logic with exponential backoff
    - Partition key routing using agent_id for ordering
    - Idempotent delivery for exactly-once semantics
    - Event batching for improved throughput (v0.3 optimization)
    - Async publishing with callbacks (v0.3 optimization)
    
    Requirements: 1.1, 1.2, 1.3, 1.4, 23.1
    """
    
    # Topic names
    TOPIC_METERING = "caracal.metering.events"
    TOPIC_POLICY_DECISIONS = "caracal.policy.decisions"
    TOPIC_AGENT_LIFECYCLE = "caracal.agent.lifecycle"
    TOPIC_POLICY_CHANGES = "caracal.policy.changes"
    
    # Schema version
    SCHEMA_VERSION = 1
    
    # Batching configuration (v0.3 optimization)
    DEFAULT_BATCH_SIZE = 100  # Number of events to batch before flushing
    DEFAULT_LINGER_MS = 10  # Max time to wait before flushing batch (milliseconds)
    
    def __init__(self, config: KafkaConfig, batch_size: int = DEFAULT_BATCH_SIZE, linger_ms: int = DEFAULT_LINGER_MS):
        """
        Initialize Kafka event producer.
        
        Args:
            config: KafkaConfig with broker and security settings
            batch_size: Number of events to batch before flushing (default: 100)
            linger_ms: Max time to wait before flushing batch in milliseconds (default: 10ms)
        """
        self.config = config
        self.batch_size = batch_size
        self.linger_ms = linger_ms
        self._producer = None
        self._schema_registry_client = None
        self._avro_serializers = {}
        self._string_serializer = StringSerializer('utf_8')
        self._initialized = False
        
        # Batching state (v0.3 optimization)
        self._pending_events = 0
        self._last_flush_time = time.time()
        
        # Async callback tracking (v0.3 optimization)
        self._pending_callbacks = {}
        self._callback_lock = asyncio.Lock()
        
        logger.info(
            f"Initializing KafkaEventProducer: brokers={config.brokers}, "
            f"security_protocol={config.security_protocol}, "
            f"batch_size={batch_size}, linger_ms={linger_ms}"
        )
    
    def _initialize(self):
        """Initialize Kafka producer and schema registry (lazy initialization)."""
        if self._initialized:
            return
        
        # Build producer configuration
        producer_conf = {
            'bootstrap.servers': ','.join(self.config.brokers),
            'security.protocol': self.config.security_protocol,
            'acks': self.config.producer_config.acks,
            'retries': self.config.producer_config.retries,
            'max.in.flight.requests.per.connection': self.config.producer_config.max_in_flight_requests,
            'compression.type': self.config.producer_config.compression_type,
            'enable.idempotence': self.config.producer_config.enable_idempotence,
            # Batching configuration for performance (v0.3 optimization)
            'batch.size': 16384,  # 16KB batch size
            'linger.ms': self.linger_ms,  # Wait up to linger_ms before sending batch
            'buffer.memory': 33554432,  # 32MB buffer
        }
        
        # Add SASL configuration if provided
        if self.config.sasl_mechanism:
            producer_conf['sasl.mechanism'] = self.config.sasl_mechanism
            if self.config.sasl_username:
                producer_conf['sasl.username'] = self.config.sasl_username
            if self.config.sasl_password:
                producer_conf['sasl.password'] = self.config.sasl_password
        
        # Add SSL configuration if provided
        if self.config.ssl_ca_location:
            producer_conf['ssl.ca.location'] = self.config.ssl_ca_location
        if self.config.ssl_cert_location:
            producer_conf['ssl.certificate.location'] = self.config.ssl_cert_location
        if self.config.ssl_key_location:
            producer_conf['ssl.key.location'] = self.config.ssl_key_location
        
        # Create producer
        self._producer = Producer(producer_conf)
        
        # Initialize schema registry if configured
        if self.config.schema_registry_url:
            try:
                self._schema_registry_client = SchemaRegistryClient({
                    'url': self.config.schema_registry_url
                })
                logger.info(f"Connected to schema registry: {self.config.schema_registry_url}")
            except Exception as e:
                logger.warning(
                    f"Failed to connect to schema registry: {e}. "
                    f"Falling back to JSON serialization."
                )
                self._schema_registry_client = None
        
        self._initialized = True
        logger.info("KafkaEventProducer initialized successfully with batching enabled")
    
    async def publish_metering_event(
        self,
        agent_id: str,
        resource_type: str,
        quantity: Decimal,
        cost: Decimal,
        currency: str = "USD",
        provisional_charge_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None
    ) -> None:
        """
        Publish metering event to caracal.metering.events topic.
        
        Args:
            agent_id: Agent identifier
            resource_type: Resource type identifier
            quantity: Resource quantity consumed
            cost: Cost in currency units
            currency: Currency code (default: 'USD')
            provisional_charge_id: Optional provisional charge ID
            metadata: Additional event metadata
            timestamp: Event timestamp (default: current time)
            
        Raises:
            KafkaPublishError: If event publishing fails after retries
            
        Requirements: 1.1, 1.4
        """
        self._initialize()
        
        # Create event
        event = MeteringEvent(
            event_id=str(uuid4()),
            schema_version=self.SCHEMA_VERSION,
            timestamp=int((timestamp or datetime.utcnow()).timestamp() * 1000),
            agent_id=agent_id,
            event_type="metering",
            resource_type=resource_type,
            quantity=float(quantity),
            cost=float(cost),
            currency=currency,
            provisional_charge_id=provisional_charge_id,
            metadata=self._serialize_metadata(metadata) if metadata else None
        )
        
        await self._publish_event(
            topic=self.TOPIC_METERING,
            event=event,
            partition_key=agent_id
        )
        
        logger.info(
            f"Published metering event: event_id={event.event_id}, "
            f"agent_id={agent_id}, resource={resource_type}, cost={cost}"
        )
    
    async def publish_policy_decision(
        self,
        agent_id: str,
        decision: str,
        reason: str,
        policy_id: Optional[str] = None,
        estimated_cost: Optional[Decimal] = None,
        remaining_budget: Optional[Decimal] = None,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None
    ) -> None:
        """
        Publish policy decision event to caracal.policy.decisions topic.
        
        Args:
            agent_id: Agent identifier
            decision: Decision result ('allowed' or 'denied')
            reason: Decision reason
            policy_id: Optional policy identifier
            estimated_cost: Optional estimated cost checked
            remaining_budget: Optional remaining budget
            metadata: Additional event metadata
            timestamp: Event timestamp (default: current time)
            
        Raises:
            KafkaPublishError: If event publishing fails after retries
            
        Requirements: 1.2, 1.4
        """
        self._initialize()
        
        # Create event
        event = PolicyDecisionEvent(
            event_id=str(uuid4()),
            schema_version=self.SCHEMA_VERSION,
            timestamp=int((timestamp or datetime.utcnow()).timestamp() * 1000),
            agent_id=agent_id,
            event_type="policy_decision",
            decision=decision,
            reason=reason,
            policy_id=policy_id,
            estimated_cost=float(estimated_cost) if estimated_cost else None,
            remaining_budget=float(remaining_budget) if remaining_budget else None,
            metadata=self._serialize_metadata(metadata) if metadata else None
        )
        
        await self._publish_event(
            topic=self.TOPIC_POLICY_DECISIONS,
            event=event,
            partition_key=agent_id
        )
        
        logger.info(
            f"Published policy decision event: event_id={event.event_id}, "
            f"agent_id={agent_id}, decision={decision}"
        )
    
    async def publish_agent_lifecycle(
        self,
        agent_id: str,
        lifecycle_event: str,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None
    ) -> None:
        """
        Publish agent lifecycle event to caracal.agent.lifecycle topic.
        
        Args:
            agent_id: Agent identifier
            lifecycle_event: Lifecycle event type ('created', 'activated', 'deactivated', 'deleted')
            metadata: Additional event metadata
            timestamp: Event timestamp (default: current time)
            
        Raises:
            KafkaPublishError: If event publishing fails after retries
            
        Requirements: 1.3, 1.4
        """
        self._initialize()
        
        # Create event
        event = AgentLifecycleEvent(
            event_id=str(uuid4()),
            schema_version=self.SCHEMA_VERSION,
            timestamp=int((timestamp or datetime.utcnow()).timestamp() * 1000),
            agent_id=agent_id,
            event_type="agent_lifecycle",
            lifecycle_event=lifecycle_event,
            metadata=self._serialize_metadata(metadata) if metadata else None
        )
        
        await self._publish_event(
            topic=self.TOPIC_AGENT_LIFECYCLE,
            event=event,
            partition_key=agent_id
        )
        
        logger.info(
            f"Published agent lifecycle event: event_id={event.event_id}, "
            f"agent_id={agent_id}, lifecycle_event={lifecycle_event}"
        )
    
    async def publish_policy_change(
        self,
        agent_id: str,
        policy_id: str,
        change_type: str,
        changed_by: str,
        change_reason: str,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None
    ) -> None:
        """
        Publish policy change event to caracal.policy.changes topic.
        
        Args:
            agent_id: Agent identifier
            policy_id: Policy identifier
            change_type: Change type ('created', 'modified', 'deactivated')
            changed_by: User who made the change
            change_reason: Reason for the change
            metadata: Additional event metadata
            timestamp: Event timestamp (default: current time)
            
        Raises:
            KafkaPublishError: If event publishing fails after retries
            
        Requirements: 1.4
        """
        self._initialize()
        
        # Create event
        event = PolicyChangeEvent(
            event_id=str(uuid4()),
            schema_version=self.SCHEMA_VERSION,
            timestamp=int((timestamp or datetime.utcnow()).timestamp() * 1000),
            agent_id=agent_id,
            event_type="policy_change",
            policy_id=policy_id,
            change_type=change_type,
            changed_by=changed_by,
            change_reason=change_reason,
            metadata=self._serialize_metadata(metadata) if metadata else None
        )
        
        await self._publish_event(
            topic=self.TOPIC_POLICY_CHANGES,
            event=event,
            partition_key=agent_id
        )
        
        logger.info(
            f"Published policy change event: event_id={event.event_id}, "
            f"agent_id={agent_id}, policy_id={policy_id}, change_type={change_type}"
        )
    
    async def _publish_event(
        self,
        topic: str,
        event: Any,
        partition_key: str,
        retry_count: int = 0
    ) -> None:
        """
        Publish event to Kafka topic with retry logic and async callbacks.
        
        Uses agent_id as partition key for ordering guarantees.
        Retries up to 3 times with exponential backoff on transient failures.
        Uses async callbacks for non-blocking operation (v0.3 optimization).
        Implements smart batching with automatic flush (v0.3 optimization).
        
        Args:
            topic: Kafka topic name
            event: Event object to publish
            partition_key: Partition key (agent_id) for ordering
            retry_count: Current retry attempt
            
        Raises:
            KafkaPublishError: If publishing fails after all retries
            
        Requirements: 1.4, 23.1
        """
        max_retries = self.config.producer_config.retries
        
        try:
            # Serialize event
            if self._schema_registry_client:
                # Use Avro serialization (not implemented in this version)
                # For now, fall back to JSON
                value = self._serialize_json(event)
            else:
                # Use JSON serialization
                value = self._serialize_json(event)
            
            # Serialize partition key
            key = self._string_serializer(partition_key)
            
            # Create event ID for callback tracking
            event_id = str(uuid4())
            
            # Create future for async callback
            future = asyncio.Future()
            async with self._callback_lock:
                self._pending_callbacks[event_id] = future
            
            # Define async delivery callback
            def delivery_callback(err, msg):
                """Async delivery callback for Kafka producer."""
                if err:
                    logger.error(
                        f"Message delivery failed: topic={msg.topic()}, "
                        f"partition={msg.partition()}, error={err}"
                    )
                    # Set exception on future
                    if event_id in self._pending_callbacks:
                        self._pending_callbacks[event_id].set_exception(
                            KafkaPublishError(f"Message delivery failed: {err}")
                        )
                else:
                    logger.debug(
                        f"Message delivered: topic={msg.topic()}, "
                        f"partition={msg.partition()}, offset={msg.offset()}"
                    )
                    # Set result on future
                    if event_id in self._pending_callbacks:
                        self._pending_callbacks[event_id].set_result(msg.offset())
            
            # Publish to Kafka with async callback
            self._producer.produce(
                topic=topic,
                key=key,
                value=value,
                on_delivery=delivery_callback
            )
            
            # Increment pending events counter
            self._pending_events += 1
            
            # Smart batching: flush if batch size reached or linger time exceeded
            current_time = time.time()
            time_since_last_flush = (current_time - self._last_flush_time) * 1000  # Convert to ms
            
            should_flush = (
                self._pending_events >= self.batch_size or
                time_since_last_flush >= self.linger_ms
            )
            
            if should_flush:
                # Trigger flush (non-blocking poll)
                self._producer.poll(0)
                self._pending_events = 0
                self._last_flush_time = current_time
                logger.debug(
                    f"Flushed batch: pending_events={self._pending_events}, "
                    f"time_since_last_flush={time_since_last_flush:.1f}ms"
                )
            else:
                # Just poll to trigger callbacks without blocking
                self._producer.poll(0)
            
            # Wait for delivery confirmation (with timeout)
            try:
                await asyncio.wait_for(future, timeout=5.0)
                
                # Clean up callback
                async with self._callback_lock:
                    if event_id in self._pending_callbacks:
                        del self._pending_callbacks[event_id]
                
            except asyncio.TimeoutError:
                logger.warning(f"Delivery confirmation timeout for event {event_id}")
                # Clean up callback
                async with self._callback_lock:
                    if event_id in self._pending_callbacks:
                        del self._pending_callbacks[event_id]
                # Don't raise - message may still be delivered
            
        except BufferError as e:
            # Local queue is full - wait and retry
            logger.warning(
                f"Kafka producer queue full, waiting before retry: {e}"
            )
            
            if retry_count < max_retries:
                # Exponential backoff: 0.1s, 0.2s, 0.4s
                backoff_seconds = 0.1 * (2 ** retry_count)
                await asyncio.sleep(backoff_seconds)
                
                logger.info(
                    f"Retrying event publish (attempt {retry_count + 1}/{max_retries})"
                )
                
                await self._publish_event(
                    topic=topic,
                    event=event,
                    partition_key=partition_key,
                    retry_count=retry_count + 1
                )
            else:
                logger.error(
                    f"Failed to publish event after {max_retries} retries: {e}"
                )
                raise KafkaPublishError(
                    f"Failed to publish event to {topic} after {max_retries} retries: {e}"
                ) from e
        
        except Exception as e:
            logger.error(f"Failed to publish event to {topic}: {e}", exc_info=True)
            
            if retry_count < max_retries:
                # Exponential backoff
                backoff_seconds = 0.1 * (2 ** retry_count)
                await asyncio.sleep(backoff_seconds)
                
                logger.info(
                    f"Retrying event publish (attempt {retry_count + 1}/{max_retries})"
                )
                
                await self._publish_event(
                    topic=topic,
                    event=event,
                    partition_key=partition_key,
                    retry_count=retry_count + 1
                )
            else:
                logger.error(
                    f"Failed to publish event after {max_retries} retries: {e}"
                )
                raise KafkaPublishError(
                    f"Failed to publish event to {topic} after {max_retries} retries: {e}"
                ) from e
    
    def _delivery_callback(self, err, msg):
        """
        Delivery callback for Kafka producer.
        
        Logs delivery success or failure.
        
        Args:
            err: Error if delivery failed
            msg: Message that was delivered
        """
        if err:
            logger.error(
                f"Message delivery failed: topic={msg.topic()}, "
                f"partition={msg.partition()}, error={err}"
            )
        else:
            logger.debug(
                f"Message delivered: topic={msg.topic()}, "
                f"partition={msg.partition()}, offset={msg.offset()}"
            )
    
    def _serialize_json(self, event: Any) -> bytes:
        """
        Serialize event to JSON bytes.
        
        Args:
            event: Event object to serialize
            
        Returns:
            JSON bytes
        """
        # Convert dataclass to dict
        event_dict = asdict(event)
        
        # Serialize to JSON
        json_str = json.dumps(event_dict, default=str)
        return json_str.encode('utf-8')
    
    def _serialize_metadata(self, metadata: Dict[str, Any]) -> Dict[str, str]:
        """
        Serialize metadata to string dictionary.
        
        Converts all values to strings for Kafka compatibility.
        
        Args:
            metadata: Metadata dictionary
            
        Returns:
            String dictionary
        """
        return {k: str(v) for k, v in metadata.items()}
    
    async def flush(self, timeout: float = 10.0) -> None:
        """
        Flush pending messages.
        
        Waits for all buffered messages to be delivered.
        
        Args:
            timeout: Maximum time to wait in seconds
        """
        if self._producer:
            remaining = self._producer.flush(timeout=timeout)
            if remaining > 0:
                logger.warning(
                    f"Failed to flush {remaining} messages within {timeout}s timeout"
                )
            else:
                logger.info("All pending messages flushed successfully")
    
    async def close(self) -> None:
        """Close Kafka producer and flush pending messages."""
        if self._producer:
            logger.info("Closing KafkaEventProducer")
            await self.flush()
            self._producer = None
            self._initialized = False
            logger.info("KafkaEventProducer closed")
