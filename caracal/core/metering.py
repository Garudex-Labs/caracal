"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Metering collector for Caracal Core.

This module provides the MeteringCollector for accepting resource usage events
and writing them to the ledger for immutable audit proof.

Enhanced MeteringEvent implementation with improvements over ASE:
- Correlation IDs for distributed tracing
- Event hierarchies for complex operations
- Tags for flexible categorization
- Structured metadata validation
- Resource type hierarchies (e.g., "mcp.tool.*")
"""

import fnmatch
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from caracal.core.ledger import LedgerWriter
from caracal.exceptions import (
    InvalidMeteringEventError,
    MeteringCollectionError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class MeteringEvent:
    """
    Enhanced metering event for tracking resource usage.
    
    Improvements over ASE:
    - Correlation IDs for distributed tracing across services
    - Event hierarchies for complex multi-step operations
    - Tags for flexible categorization without rigid schemas
    - Structured metadata validation
    - Resource type hierarchies enable pattern-based filtering
    
    Attributes:
        principal_id: Unique identifier for the agent consuming resources
        resource_type: Type of resource (supports hierarchical patterns like "mcp.tool.search")
        quantity: Amount of resource consumed (non-negative)
        timestamp: When the event occurred (auto-generated if not provided)
        metadata: Extensible dictionary for additional context
        correlation_id: Optional ID for tracing related events across services
        parent_event_id: Optional ID for building event hierarchies
        tags: Optional list of tags for categorization and filtering
    """
    principal_id: str
    resource_type: str
    quantity: Decimal
    timestamp: Optional[datetime] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    correlation_id: Optional[str] = None
    parent_event_id: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    
    def __post_init__(self):
        """Set default timestamp and validate fields."""
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        self._validate()
    
    def _validate(self):
        """
        Validate event fields.
        
        Raises:
            InvalidMeteringEventError: If validation fails
        """
        if not self.principal_id or not isinstance(self.principal_id, str):
            raise InvalidMeteringEventError("principal_id must be non-empty string")
        
        if not self.resource_type or not isinstance(self.resource_type, str):
            raise InvalidMeteringEventError("resource_type must be non-empty string")
        
        if not isinstance(self.quantity, Decimal):
            raise InvalidMeteringEventError(
                f"quantity must be a Decimal, got {type(self.quantity).__name__}"
            )
        
        if self.quantity < 0:
            raise InvalidMeteringEventError(
                f"quantity must be non-negative, got {self.quantity}"
            )
        
        if self.timestamp is not None and not isinstance(self.timestamp, datetime):
            raise InvalidMeteringEventError(
                f"timestamp must be a datetime object, got {type(self.timestamp).__name__}"
            )
    
    def matches_resource_pattern(self, pattern: str) -> bool:
        """
        Check if resource_type matches a hierarchical pattern.
        
        Supports wildcards: "mcp.tool.*" matches "mcp.tool.search"
        
        Args:
            pattern: Pattern to match against (supports * and ? wildcards)
            
        Returns:
            True if resource_type matches the pattern
        """
        return fnmatch.fnmatch(self.resource_type, pattern)
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for JSON serialization.
        
        Returns:
            Dictionary representation of the event
        """
        return {
            "principal_id": self.principal_id,
            "resource_type": self.resource_type,
            "quantity": str(self.quantity),
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "metadata": self.metadata,
            "correlation_id": self.correlation_id,
            "parent_event_id": self.parent_event_id,
            "tags": self.tags
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MeteringEvent":
        """
        Create MeteringEvent from dictionary.
        
        Args:
            data: Dictionary containing event data
            
        Returns:
            MeteringEvent instance
        """
        return cls(
            principal_id=data["principal_id"],
            resource_type=data["resource_type"],
            quantity=Decimal(data["quantity"]),
            timestamp=datetime.fromisoformat(data["timestamp"]) if data.get("timestamp") else None,
            metadata=data.get("metadata", {}),
            correlation_id=data.get("correlation_id"),
            parent_event_id=data.get("parent_event_id"),
            tags=data.get("tags", [])
        )


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
            
            # Prepare metadata with enhanced fields
            enhanced_metadata = dict(event.metadata) if event.metadata else {}
            
            # Add enhanced fields to metadata if present
            if event.correlation_id:
                enhanced_metadata["correlation_id"] = event.correlation_id
            if event.parent_event_id:
                enhanced_metadata["parent_event_id"] = event.parent_event_id
            if event.tags:
                enhanced_metadata["tags"] = event.tags
            
            # Write to ledger
            ledger_event = self.ledger_writer.append_event(
                principal_id=event.principal_id,
                resource_type=event.resource_type,
                quantity=event.quantity,
                metadata=enhanced_metadata if enhanced_metadata else None,
                timestamp=event.timestamp,
            )
            
            logger.info(
                f"Collected event: principal_id={event.principal_id}, "
                f"resource={event.resource_type}, quantity={event.quantity}, "
                f"event_id={ledger_event.event_id}"
            )
            
        except InvalidMeteringEventError:
            raise
        except Exception as e:
            logger.error(
                f"Failed to collect event for agent {event.principal_id}: {e}",
                exc_info=True
            )
            raise MeteringCollectionError(
                f"Failed to collect event for agent {event.principal_id}: {e}"
            ) from e

    def _validate_event(self, event: MeteringEvent) -> None:
        """
        Validate event data.
        """
        if not event.principal_id or not isinstance(event.principal_id, str):
            logger.warning("Event validation failed: principal_id must be a non-empty string")
            raise InvalidMeteringEventError(
                "principal_id must be a non-empty string"
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
            f"Validated event: principal_id={event.principal_id}, "
            f"resource={event.resource_type}"
        )


