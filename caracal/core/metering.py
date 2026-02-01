"""
Metering collector for Caracal Core.

This module provides the MeteringCollector for accepting metering events,
validating them against ASE schema, calculating costs, and writing to the ledger.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional

from ase.protocol import MeteringEvent
from caracal.core.ledger import LedgerWriter
from caracal.core.pricebook import Pricebook
from caracal.exceptions import (
    InvalidMeteringEventError,
    MeteringCollectionError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)




class MeteringCollector:
    """
    Collects metering events, calculates costs, and writes to ledger.
    
    Responsibilities:
    - Accept metering events
    - Validate events against ASE schema
    - Look up prices in Pricebook
    - Calculate provisional charges (quantity * price)
    - Pass events to LedgerWriter
    """

    def __init__(self, pricebook: Pricebook, ledger_writer: LedgerWriter):
        """
        Initialize MeteringCollector.
        
        Args:
            pricebook: Pricebook instance for price lookups
            ledger_writer: LedgerWriter instance for persisting events
        """
        self.pricebook = pricebook
        self.ledger_writer = ledger_writer
        logger.info("MeteringCollector initialized")

    def collect_event(self, event: MeteringEvent) -> None:
        """
        Accept a metering event, calculate cost, and write to ledger.
        
        This method:
        1. Validates the event
        2. Looks up the resource price
        3. Calculates the cost (quantity * price)
        4. Writes the event to the ledger
        
        Args:
            event: MeteringEvent to collect
            
        Raises:
            InvalidMeteringEventError: If event validation fails
            MeteringCollectionError: If event collection fails
        """
        try:
            # Validate event
            self._validate_event(event)
            
            # Calculate cost
            cost = self._calculate_cost(event.resource_type, event.quantity)
            
            # Write to ledger
            ledger_event = self.ledger_writer.append_event(
                agent_id=event.agent_id,
                resource_type=event.resource_type,
                quantity=event.quantity,
                cost=cost,
                currency="USD",  # v0.1 only supports USD
                metadata=event.metadata,
                timestamp=event.timestamp,
            )
            
            logger.info(
                f"Collected metering event: agent_id={event.agent_id}, "
                f"resource={event.resource_type}, quantity={event.quantity}, "
                f"cost={cost} USD, event_id={ledger_event.event_id}"
            )
            
        except InvalidMeteringEventError:
            # Re-raise validation errors (already logged in _validate_event)
            raise
        except Exception as e:
            logger.error(
                f"Failed to collect metering event for agent {event.agent_id}: {e}",
                exc_info=True
            )
            raise MeteringCollectionError(
                f"Failed to collect metering event for agent {event.agent_id}: {e}"
            ) from e

    def _validate_event(self, event: MeteringEvent) -> None:
        """
        Validate metering event conforms to ASE schema requirements.
        
        For v0.1, this performs basic validation:
        - agent_id is not empty
        - resource_type is not empty
        - quantity is non-negative
        - timestamp is valid
        
        Future versions will use full ASE protocol validation.
        
        Args:
            event: MeteringEvent to validate
            
        Raises:
            InvalidMeteringEventError: If validation fails
        """
        # Validate agent_id
        if not event.agent_id or not isinstance(event.agent_id, str):
            logger.warning("Metering event validation failed: agent_id must be a non-empty string")
            raise InvalidMeteringEventError(
                "agent_id must be a non-empty string"
            )
        
        # Validate resource_type
        if not event.resource_type or not isinstance(event.resource_type, str):
            logger.warning("Metering event validation failed: resource_type must be a non-empty string")
            raise InvalidMeteringEventError(
                "resource_type must be a non-empty string"
            )
        
        # Validate quantity
        if not isinstance(event.quantity, Decimal):
            logger.warning(
                f"Metering event validation failed: quantity must be a Decimal, got {type(event.quantity).__name__}"
            )
            raise InvalidMeteringEventError(
                f"quantity must be a Decimal, got {type(event.quantity).__name__}"
            )
        
        if event.quantity < 0:
            logger.warning(f"Metering event validation failed: quantity must be non-negative, got {event.quantity}")
            raise InvalidMeteringEventError(
                f"quantity must be non-negative, got {event.quantity}"
            )
        
        # Validate timestamp
        if event.timestamp is not None and not isinstance(event.timestamp, datetime):
            logger.warning(
                f"Metering event validation failed: timestamp must be a datetime object, "
                f"got {type(event.timestamp).__name__}"
            )
            raise InvalidMeteringEventError(
                f"timestamp must be a datetime object, got {type(event.timestamp).__name__}"
            )
        
        logger.debug(
            f"Validated metering event: agent_id={event.agent_id}, "
            f"resource={event.resource_type}"
        )

    def _calculate_cost(self, resource_type: str, quantity: Decimal) -> Decimal:
        """
        Calculate cost for a metering event.
        
        Looks up the price in the pricebook and multiplies by quantity.
        If the resource is not in the pricebook, uses a default price of zero
        and logs a warning.
        
        Args:
            resource_type: The resource identifier
            quantity: Amount of resource consumed
            
        Returns:
            Calculated cost as Decimal
        """
        # Look up price in pricebook
        price = self.pricebook.get_price(resource_type)
        
        # get_price returns Decimal("0") for unknown resources
        # and logs a warning internally
        
        # Calculate cost
        cost = price * quantity
        
        logger.debug(
            f"Calculated cost: resource={resource_type}, "
            f"quantity={quantity}, price={price}, cost={cost}"
        )
        
        return cost
