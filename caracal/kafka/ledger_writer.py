"""
LedgerWriter Consumer for Caracal Core v0.3.

Consumes metering events from Kafka and writes them to PostgreSQL ledger.
Validates event schema, writes to database, and releases provisional charges.

Requirements: 2.1, 2.4
"""

import json
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.kafka.consumer import BaseKafkaConsumer, KafkaMessage
from caracal.db.models import LedgerEvent
from caracal.logging_config import get_logger
from caracal.exceptions import InvalidLedgerEventError

logger = get_logger(__name__)


class LedgerWriterConsumer(BaseKafkaConsumer):
    """
    Kafka consumer that writes metering events to PostgreSQL ledger.
    
    Subscribes to caracal.metering.events topic and:
    1. Validates event schema
    2. Writes event to ledger_events table
    3. Releases provisional charge if present
    4. Commits offset after successful processing
    
    Uses exactly-once semantics to ensure events are written exactly once.
    
    Requirements: 2.1, 2.4
    """
    
    # Topic to subscribe to
    TOPIC = "caracal.metering.events"
    
    # Consumer group ID
    CONSUMER_GROUP = "ledger-writer-group"
    
    def __init__(
        self,
        brokers: List[str],
        db_session_factory,
        security_protocol: str = "PLAINTEXT",
        sasl_mechanism: Optional[str] = None,
        sasl_username: Optional[str] = None,
        sasl_password: Optional[str] = None,
        ssl_ca_location: Optional[str] = None,
        ssl_cert_location: Optional[str] = None,
        ssl_key_location: Optional[str] = None,
        enable_transactions: bool = True,
        merkle_batcher=None
    ):
        """
        Initialize LedgerWriter consumer.
        
        Args:
            brokers: List of Kafka broker addresses
            db_session_factory: Factory function to create database sessions
            security_protocol: Security protocol for Kafka
            sasl_mechanism: SASL mechanism for authentication
            sasl_username: SASL username
            sasl_password: SASL password
            ssl_ca_location: Path to CA certificate
            ssl_cert_location: Path to client certificate
            ssl_key_location: Path to client private key
            enable_transactions: Enable exactly-once semantics
            merkle_batcher: Optional MerkleBatcher for adding events to Merkle tree
        """
        super().__init__(
            brokers=brokers,
            topics=[self.TOPIC],
            consumer_group=self.CONSUMER_GROUP,
            security_protocol=security_protocol,
            sasl_mechanism=sasl_mechanism,
            sasl_username=sasl_username,
            sasl_password=sasl_password,
            ssl_ca_location=ssl_ca_location,
            ssl_cert_location=ssl_cert_location,
            ssl_key_location=ssl_key_location,
            enable_transactions=enable_transactions
        )
        
        self.db_session_factory = db_session_factory
        self.merkle_batcher = merkle_batcher
        
        logger.info(
            f"Initialized LedgerWriterConsumer: topic={self.TOPIC}, "
            f"group={self.CONSUMER_GROUP}, enable_transactions={enable_transactions}"
        )
    
    async def process_message(self, message: KafkaMessage) -> None:
        """
        Process metering event from Kafka.
        
        Steps:
        1. Deserialize and validate event
        2. Write event to ledger_events table
        3. Release provisional charge if present
        4. Add event to Merkle batcher (if configured)
        
        Args:
            message: Kafka message containing metering event
            
        Raises:
            InvalidLedgerEventError: If event validation fails
            Exception: If database write fails
            
        Requirements: 2.1, 2.4
        """
        # Deserialize event
        try:
            event_data = message.deserialize_json()
        except Exception as e:
            logger.error(
                f"Failed to deserialize metering event: {e}",
                exc_info=True
            )
            raise InvalidLedgerEventError(f"Invalid JSON in metering event: {e}") from e
        
        # Validate event schema
        self._validate_event_schema(event_data)
        
        # Extract event fields
        agent_id = UUID(event_data['agent_id'])
        resource_type = event_data['resource_type']
        quantity = Decimal(str(event_data['quantity']))
        cost = Decimal(str(event_data['cost']))
        currency = event_data['currency']
        # provisional_charge_id removed
        metadata = event_data.get('metadata')
        
        # Convert timestamp from Unix milliseconds to datetime
        timestamp_ms = event_data['timestamp']
        timestamp = datetime.utcfromtimestamp(timestamp_ms / 1000.0)
        
        # Create database session
        session = self.db_session_factory()
        
        try:
            # Write event to ledger_events table
            ledger_event = LedgerEvent(
                agent_id=agent_id,
                timestamp=timestamp,
                resource_type=resource_type,
                quantity=quantity,
                cost=cost,
                currency=currency,
                event_metadata=metadata,
                # provisional_charge_id removed
            )
            
            session.add(ledger_event)
            session.flush()  # Flush to get event_id
            
            logger.info(
                f"Wrote ledger event: event_id={ledger_event.event_id}, "
                f"agent_id={agent_id}, resource={resource_type}, cost={cost} {currency}"
            )
            
            # Release provisional charge removed
            
            # Commit database transaction
            session.commit()
            
            # Add event to Merkle batcher (if configured)
            # This happens after database commit to ensure event is persisted
            if self.merkle_batcher:
                await self._add_to_merkle_batcher(ledger_event)
            
            logger.debug(
                f"Successfully processed metering event: "
                f"event_id={ledger_event.event_id}, kafka_offset={message.offset}"
            )
        
        except Exception as e:
            # Rollback on error
            session.rollback()
            logger.error(
                f"Failed to write ledger event: {e}",
                exc_info=True
            )
            raise
        
        finally:
            session.close()
    
    def _validate_event_schema(self, event_data: dict) -> None:
        """
        Validate metering event schema.
        
        Required fields:
        - event_id: str
        - schema_version: int
        - timestamp: int (Unix milliseconds)
        - agent_id: str (UUID)
        - event_type: str (must be 'metering')
        - resource_type: str
        - quantity: float
        - cost: float
        - currency: str
        
        Optional fields:
        - provisional_charge_id: str (UUID)
        - metadata: dict
        
        Args:
            event_data: Deserialized event data
            
        Raises:
            InvalidLedgerEventError: If validation fails
        """
        # Check required fields
        required_fields = [
            'event_id',
            'schema_version',
            'timestamp',
            'agent_id',
            'event_type',
            'resource_type',
            'quantity',
            'cost',
            'currency'
        ]
        
        for field in required_fields:
            if field not in event_data:
                raise InvalidLedgerEventError(f"Missing required field: {field}")
        
        # Validate event_type
        if event_data['event_type'] != 'metering':
            raise InvalidLedgerEventError(
                f"Invalid event_type: expected 'metering', got '{event_data['event_type']}'"
            )
        
        # Validate agent_id is valid UUID
        try:
            UUID(event_data['agent_id'])
        except (ValueError, TypeError) as e:
            raise InvalidLedgerEventError(f"Invalid agent_id UUID: {e}") from e
        
        # Validate numeric fields
        try:
            quantity = Decimal(str(event_data['quantity']))
            if quantity < 0:
                raise InvalidLedgerEventError(
                    f"quantity must be non-negative, got {quantity}"
                )
        except (ValueError, TypeError) as e:
            raise InvalidLedgerEventError(f"Invalid quantity: {e}") from e
        
        try:
            cost = Decimal(str(event_data['cost']))
            if cost < 0:
                raise InvalidLedgerEventError(
                    f"cost must be non-negative, got {cost}"
                )
        except (ValueError, TypeError) as e:
            raise InvalidLedgerEventError(f"Invalid cost: {e}") from e
        
        # Validate timestamp
        try:
            timestamp_ms = int(event_data['timestamp'])
            if timestamp_ms < 0:
                raise InvalidLedgerEventError(
                    f"timestamp must be non-negative, got {timestamp_ms}"
                )
        except (ValueError, TypeError) as e:
            raise InvalidLedgerEventError(f"Invalid timestamp: {e}") from e
        
        logger.debug(f"Event schema validation passed: event_id={event_data['event_id']}")
    
    
    async def _add_to_merkle_batcher(self, ledger_event: LedgerEvent) -> None:
        """
        Add ledger event to Merkle batcher.
        
        This is called after the event is successfully written to the database.
        The Merkle batcher will accumulate events and create Merkle trees
        when batch thresholds are reached.
        
        Args:
            ledger_event: Ledger event to add to batcher
            
        Requirements: 2.1, 3.1, 3.2
        """
        try:
            if self.merkle_batcher:
                await self.merkle_batcher.add_event(ledger_event)
                logger.debug(
                    f"Added event to Merkle batcher: event_id={ledger_event.event_id}"
                )
        except Exception as e:
            logger.error(
                f"Failed to add event to Merkle batcher: {e}",
                exc_info=True
            )
            # Don't raise - Merkle batching is not critical for event processing
            # Events can be backfilled into Merkle trees later if needed
