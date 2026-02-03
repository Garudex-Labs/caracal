"""
Event Replay Manager for Caracal Core v0.3.

Provides functionality to replay events from Kafka by resetting consumer group offsets,
validating event ordering, and tracking replay progress.

Requirements: 11.1, 11.2, 11.3, 11.6, 11.7
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Dict, Any
from uuid import UUID, uuid4

from confluent_kafka import Consumer, TopicPartition, KafkaException
from confluent_kafka.admin import AdminClient

from caracal.logging_config import get_logger
from caracal.exceptions import EventReplayError

logger = get_logger(__name__)


@dataclass
class ReplayProgress:
    """
    Tracks progress of an event replay operation.
    
    Attributes:
        replay_id: Unique identifier for this replay operation
        consumer_group: Consumer group being replayed
        topics: Topics being replayed
        start_timestamp: Timestamp to replay from
        start_time: When replay started
        end_time: When replay ended (None if still running)
        events_processed: Number of events processed
        current_offsets: Current offsets per partition
        status: Replay status ('running', 'completed', 'failed')
        error_message: Error message if failed
    """
    replay_id: UUID
    consumer_group: str
    topics: List[str]
    start_timestamp: datetime
    start_time: datetime
    end_time: Optional[datetime] = None
    events_processed: int = 0
    current_offsets: Dict[str, Dict[int, int]] = None  # topic -> partition -> offset
    status: str = "running"  # 'running', 'completed', 'failed'
    error_message: Optional[str] = None
    
    def __post_init__(self):
        if self.current_offsets is None:
            self.current_offsets = {}


@dataclass
class ReplayValidation:
    """
    Validation results for event replay.
    
    Attributes:
        total_events: Total events processed
        ordered_events: Number of events in correct order
        out_of_order_events: Number of out-of-order events
        out_of_order_details: Details of out-of-order events
        validation_passed: Whether validation passed
    """
    total_events: int
    ordered_events: int
    out_of_order_events: int
    out_of_order_details: List[Dict[str, Any]]
    validation_passed: bool


class EventReplayManager:
    """
    Manages event replay operations from Kafka.
    
    Provides functionality to:
    - Reset consumer group offsets to specific timestamp
    - Validate event ordering during replay
    - Track replay progress
    - Log replay operations
    
    Requirements: 11.1, 11.2, 11.3, 11.6, 11.7
    """
    
    def __init__(
        self,
        brokers: List[str],
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None
    ):
        """
        Initialize Event Replay Manager.
        
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
        
        # Track active replay operations
        self._active_replays: Dict[UUID, ReplayProgress] = {}
        
        logger.info(f"EventReplayManager initialized: brokers={brokers}")
    
    def _build_admin_config(self) -> Dict[str, Any]:
        """Build Kafka admin client configuration."""
        config = {
            'bootstrap.servers': ','.join(self.brokers),
            'security.protocol': self.security_protocol,
        }
        
        if self.sasl_mechanism:
            config['sasl.mechanism'] = self.sasl_mechanism
            if self.sasl_username:
                config['sasl.username'] = self.sasl_username
            if self.sasl_password:
                config['sasl.password'] = self.sasl_password
        
        if self.ssl_ca_location:
            config['ssl.ca.location'] = self.ssl_ca_location
        if self.ssl_cert_location:
            config['ssl.certificate.location'] = self.ssl_cert_location
        if self.ssl_key_location:
            config['ssl.key.location'] = self.ssl_key_location
        
        return config
    
    def _build_consumer_config(self, consumer_group: str) -> Dict[str, Any]:
        """Build Kafka consumer configuration."""
        config = {
            'bootstrap.servers': ','.join(self.brokers),
            'group.id': consumer_group,
            'security.protocol': self.security_protocol,
            'enable.auto.commit': False,
            'auto.offset.reset': 'earliest',
        }
        
        if self.sasl_mechanism:
            config['sasl.mechanism'] = self.sasl_mechanism
            if self.sasl_username:
                config['sasl.username'] = self.sasl_username
            if self.sasl_password:
                config['sasl.password'] = self.sasl_password
        
        if self.ssl_ca_location:
            config['ssl.ca.location'] = self.ssl_ca_location
        if self.ssl_cert_location:
            config['ssl.certificate.location'] = self.ssl_cert_location
        if self.ssl_key_location:
            config['ssl.key.location'] = self.ssl_key_location
        
        return config
    
    async def reset_consumer_group_offset(
        self,
        consumer_group: str,
        topics: List[str],
        timestamp: datetime
    ) -> Dict[str, Dict[int, int]]:
        """
        Reset consumer group offsets to specific timestamp.
        
        This allows replaying events from a specific point in time.
        
        Args:
            consumer_group: Consumer group to reset
            topics: Topics to reset offsets for
            timestamp: Timestamp to reset to
            
        Returns:
            Dictionary mapping topic -> partition -> new offset
            
        Raises:
            EventReplayError: If offset reset fails
            
        Requirements: 11.1, 11.2
        """
        try:
            logger.info(
                f"Resetting consumer group offsets: group={consumer_group}, "
                f"topics={topics}, timestamp={timestamp}"
            )
            
            # Convert datetime to milliseconds since epoch
            timestamp_ms = int(timestamp.timestamp() * 1000)
            
            # Create consumer to get partition assignments
            consumer_config = self._build_consumer_config(consumer_group)
            consumer = Consumer(consumer_config)
            
            # Get partition metadata for topics
            cluster_metadata = consumer.list_topics()
            
            # Build list of TopicPartition objects
            topic_partitions = []
            for topic in topics:
                if topic not in cluster_metadata.topics:
                    raise EventReplayError(f"Topic not found: {topic}")
                
                topic_metadata = cluster_metadata.topics[topic]
                for partition_id in topic_metadata.partitions.keys():
                    tp = TopicPartition(topic, partition_id, timestamp_ms)
                    topic_partitions.append(tp)
            
            logger.info(f"Found {len(topic_partitions)} partitions to reset")
            
            # Get offsets for timestamp
            offsets_for_times = consumer.offsets_for_times(topic_partitions)
            
            # Build result dictionary and commit new offsets
            new_offsets = {}
            partitions_to_commit = []
            
            for tp in offsets_for_times:
                if tp.offset < 0:
                    # No offset found for timestamp (topic empty or timestamp too old)
                    logger.warning(
                        f"No offset found for timestamp: topic={tp.topic}, "
                        f"partition={tp.partition}, timestamp={timestamp}"
                    )
                    # Use earliest offset
                    tp.offset = 0
                
                # Track new offset
                if tp.topic not in new_offsets:
                    new_offsets[tp.topic] = {}
                new_offsets[tp.topic][tp.partition] = tp.offset
                
                # Add to commit list
                partitions_to_commit.append(tp)
                
                logger.info(
                    f"Reset offset: topic={tp.topic}, partition={tp.partition}, "
                    f"offset={tp.offset}"
                )
            
            # Commit new offsets
            consumer.commit(offsets=partitions_to_commit, asynchronous=False)
            
            logger.info(
                f"Successfully reset {len(partitions_to_commit)} partition offsets "
                f"for consumer group {consumer_group}"
            )
            
            # Close consumer
            consumer.close()
            
            return new_offsets
        
        except KafkaException as e:
            error_msg = f"Failed to reset consumer group offsets: {e}"
            logger.error(error_msg, exc_info=True)
            raise EventReplayError(error_msg) from e
        
        except Exception as e:
            error_msg = f"Unexpected error resetting offsets: {e}"
            logger.error(error_msg, exc_info=True)
            raise EventReplayError(error_msg) from e
    
    async def start_replay(
        self,
        consumer_group: str,
        topics: List[str],
        start_timestamp: datetime
    ) -> UUID:
        """
        Start event replay operation.
        
        Resets consumer group offsets and begins tracking replay progress.
        
        Args:
            consumer_group: Consumer group to replay
            topics: Topics to replay
            start_timestamp: Timestamp to replay from
            
        Returns:
            Replay ID for tracking progress
            
        Raises:
            EventReplayError: If replay start fails
            
        Requirements: 11.1, 11.2, 11.7
        """
        try:
            # Generate replay ID
            replay_id = uuid4()
            
            logger.info(
                f"Starting event replay: replay_id={replay_id}, "
                f"consumer_group={consumer_group}, topics={topics}, "
                f"start_timestamp={start_timestamp}"
            )
            
            # Reset consumer group offsets
            new_offsets = await self.reset_consumer_group_offset(
                consumer_group,
                topics,
                start_timestamp
            )
            
            # Create replay progress tracker
            progress = ReplayProgress(
                replay_id=replay_id,
                consumer_group=consumer_group,
                topics=topics,
                start_timestamp=start_timestamp,
                start_time=datetime.utcnow(),
                current_offsets=new_offsets,
                status="running"
            )
            
            # Track replay
            self._active_replays[replay_id] = progress
            
            logger.info(
                f"Event replay started: replay_id={replay_id}, "
                f"partitions_reset={sum(len(partitions) for partitions in new_offsets.values())}"
            )
            
            return replay_id
        
        except Exception as e:
            error_msg = f"Failed to start event replay: {e}"
            logger.error(error_msg, exc_info=True)
            raise EventReplayError(error_msg) from e
    
    def update_replay_progress(
        self,
        replay_id: UUID,
        events_processed: int,
        current_offsets: Dict[str, Dict[int, int]]
    ) -> None:
        """
        Update replay progress.
        
        Args:
            replay_id: Replay ID
            events_processed: Number of events processed
            current_offsets: Current offsets per partition
            
        Requirements: 11.7
        """
        if replay_id not in self._active_replays:
            logger.warning(f"Replay not found: replay_id={replay_id}")
            return
        
        progress = self._active_replays[replay_id]
        progress.events_processed = events_processed
        progress.current_offsets = current_offsets
        
        logger.debug(
            f"Replay progress updated: replay_id={replay_id}, "
            f"events_processed={events_processed}"
        )
    
    def complete_replay(self, replay_id: UUID) -> None:
        """
        Mark replay as completed.
        
        Args:
            replay_id: Replay ID
            
        Requirements: 11.7
        """
        if replay_id not in self._active_replays:
            logger.warning(f"Replay not found: replay_id={replay_id}")
            return
        
        progress = self._active_replays[replay_id]
        progress.status = "completed"
        progress.end_time = datetime.utcnow()
        
        duration = (progress.end_time - progress.start_time).total_seconds()
        
        logger.info(
            f"Event replay completed: replay_id={replay_id}, "
            f"events_processed={progress.events_processed}, "
            f"duration={duration:.2f}s"
        )
    
    def fail_replay(self, replay_id: UUID, error_message: str) -> None:
        """
        Mark replay as failed.
        
        Args:
            replay_id: Replay ID
            error_message: Error message
            
        Requirements: 11.7
        """
        if replay_id not in self._active_replays:
            logger.warning(f"Replay not found: replay_id={replay_id}")
            return
        
        progress = self._active_replays[replay_id]
        progress.status = "failed"
        progress.end_time = datetime.utcnow()
        progress.error_message = error_message
        
        logger.error(
            f"Event replay failed: replay_id={replay_id}, "
            f"error={error_message}"
        )
    
    def get_replay_progress(self, replay_id: UUID) -> Optional[ReplayProgress]:
        """
        Get replay progress.
        
        Args:
            replay_id: Replay ID
            
        Returns:
            ReplayProgress object or None if not found
            
        Requirements: 11.7
        """
        return self._active_replays.get(replay_id)
    
    def list_active_replays(self) -> List[ReplayProgress]:
        """
        List all active replay operations.
        
        Returns:
            List of ReplayProgress objects
            
        Requirements: 11.7
        """
        return [
            progress for progress in self._active_replays.values()
            if progress.status == "running"
        ]
    
    def list_all_replays(self) -> List[ReplayProgress]:
        """
        List all replay operations (active and completed).
        
        Returns:
            List of ReplayProgress objects
            
        Requirements: 11.7
        """
        return list(self._active_replays.values())
    
    async def validate_event_ordering(
        self,
        consumer_group: str,
        topics: List[str],
        max_events: Optional[int] = None
    ) -> ReplayValidation:
        """
        Validate event ordering during replay.
        
        Checks that events are processed in chronological order based on timestamps.
        
        Args:
            consumer_group: Consumer group to validate
            topics: Topics to validate
            max_events: Maximum events to check (None for all)
            
        Returns:
            ReplayValidation object with validation results
            
        Raises:
            EventReplayError: If validation fails
            
        Requirements: 11.3, 11.6
        """
        try:
            logger.info(
                f"Validating event ordering: consumer_group={consumer_group}, "
                f"topics={topics}, max_events={max_events}"
            )
            
            # Create consumer
            consumer_config = self._build_consumer_config(consumer_group)
            consumer = Consumer(consumer_config)
            
            # Subscribe to topics
            consumer.subscribe(topics)
            
            # Track validation results
            total_events = 0
            ordered_events = 0
            out_of_order_events = 0
            out_of_order_details = []
            
            # Track last timestamp per partition
            last_timestamps: Dict[str, Dict[int, int]] = {}
            
            # Poll for events
            try:
                while True:
                    if max_events and total_events >= max_events:
                        break
                    
                    msg = consumer.poll(timeout=1.0)
                    
                    if msg is None:
                        # No more messages
                        break
                    
                    if msg.error():
                        continue
                    
                    # Get message timestamp
                    timestamp_type, timestamp_ms = msg.timestamp()
                    if timestamp_type != 1:  # Not a valid timestamp
                        continue
                    
                    topic = msg.topic()
                    partition = msg.partition()
                    offset = msg.offset()
                    
                    # Initialize tracking for this partition
                    if topic not in last_timestamps:
                        last_timestamps[topic] = {}
                    
                    # Check ordering
                    if partition in last_timestamps[topic]:
                        last_ts = last_timestamps[topic][partition]
                        
                        if timestamp_ms >= last_ts:
                            # In order
                            ordered_events += 1
                        else:
                            # Out of order
                            out_of_order_events += 1
                            out_of_order_details.append({
                                "topic": topic,
                                "partition": partition,
                                "offset": offset,
                                "timestamp": timestamp_ms,
                                "previous_timestamp": last_ts,
                                "time_diff_ms": timestamp_ms - last_ts
                            })
                            
                            logger.warning(
                                f"Out-of-order event detected: topic={topic}, "
                                f"partition={partition}, offset={offset}, "
                                f"timestamp={timestamp_ms}, previous={last_ts}"
                            )
                    else:
                        # First event for this partition
                        ordered_events += 1
                    
                    # Update last timestamp
                    last_timestamps[topic][partition] = timestamp_ms
                    
                    total_events += 1
            
            finally:
                consumer.close()
            
            # Build validation result
            validation = ReplayValidation(
                total_events=total_events,
                ordered_events=ordered_events,
                out_of_order_events=out_of_order_events,
                out_of_order_details=out_of_order_details,
                validation_passed=(out_of_order_events == 0)
            )
            
            logger.info(
                f"Event ordering validation completed: total={total_events}, "
                f"ordered={ordered_events}, out_of_order={out_of_order_events}, "
                f"passed={validation.validation_passed}"
            )
            
            return validation
        
        except Exception as e:
            error_msg = f"Failed to validate event ordering: {e}"
            logger.error(error_msg, exc_info=True)
            raise EventReplayError(error_msg) from e
