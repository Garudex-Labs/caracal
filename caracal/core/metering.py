"""
Metering collector for Caracal Core.

This module provides the MeteringCollector for accepting resource usage events
and writing them to the ledger for immutable audit proof.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional

from ase.protocol import MeteringEvent
from caracal.core.ledger import LedgerWriter
from caracal.exceptions import (
    InvalidMeteringEventError,
    MeteringCollectionError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MeteringCollector:
    """
    Collects resource usage events and writes to ledger.
    
    Responsibilities:
    - Accept usage events
    - Validate events
    - Pass events to LedgerWriter for persistence
    """

    def __init__(self, ledger_writer: LedgerWriter):
        """
        Initialize MeteringCollector.
        
        Args:
            ledger_writer: LedgerWriter instance for persisting events
        """
        self.ledger_writer = ledger_writer
        logger.info("MeteringCollector initialized")

    def collect_event(self, event: MeteringEvent) -> None:
        """
        Accept an event and write to ledger.
        
        Args:
            event: MeteringEvent to collect
            
        Raises:
            InvalidMeteringEventError: If event validation fails
            MeteringCollectionError: If event collection fails
        """
        try:
            # Validate event
            self._validate_event(event)
            
            # Write to ledger
            ledger_event = self.ledger_writer.append_event(
                agent_id=event.agent_id,
                resource_type=event.resource_type,
                quantity=event.quantity,
                metadata=event.metadata,
                timestamp=event.timestamp,
            )
            
            logger.info(
                f"Collected event: agent_id={event.agent_id}, "
                f"resource={event.resource_type}, quantity={event.quantity}, "
                f"event_id={ledger_event.event_id}"
            )
            
        except InvalidMeteringEventError:
            raise
        except Exception as e:
            logger.error(
                f"Failed to collect event for agent {event.agent_id}: {e}",
                exc_info=True
            )
            raise MeteringCollectionError(
                f"Failed to collect event for agent {event.agent_id}: {e}"
            ) from e

    def _validate_event(self, event: MeteringEvent) -> None:
        """
        Validate event data.
        """
        if not event.agent_id or not isinstance(event.agent_id, str):
            logger.warning("Event validation failed: agent_id must be a non-empty string")
            raise InvalidMeteringEventError(
                "agent_id must be a non-empty string"
            )
        
        if not event.resource_type or not isinstance(event.resource_type, str):
            logger.warning("Event validation failed: resource_type must be a non-empty string")
            raise InvalidMeteringEventError(
                "resource_type must be a non-empty string"
            )
        
        if not isinstance(event.quantity, Decimal):
            logger.warning(
                f"Event validation failed: quantity must be a Decimal, got {type(event.quantity).__name__}"
            )
            raise InvalidMeteringEventError(
                f"quantity must be a Decimal, got {type(event.quantity).__name__}"
            )
        
        if event.quantity < 0:
            logger.warning(f"Event validation failed: quantity must be non-negative, got {event.quantity}")
            raise InvalidMeteringEventError(
                f"quantity must be non-negative, got {event.quantity}"
            )
        
        if event.timestamp is not None and not isinstance(event.timestamp, datetime):
            logger.warning(
                f"Event validation failed: timestamp must be a datetime object, "
                f"got {type(event.timestamp).__name__}"
            )
            raise InvalidMeteringEventError(
                f"timestamp must be a datetime object, got {type(event.timestamp).__name__}"
            )
        
        logger.debug(
            f"Validated event: agent_id={event.agent_id}, "
            f"resource={event.resource_type}"
        )


