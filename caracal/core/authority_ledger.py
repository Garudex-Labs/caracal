"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authority ledger operations for authority enforcement.

This module provides the AuthorityLedgerWriter for recording authority events
and AuthorityLedgerQuery for querying authority ledger events.

"""

from datetime import datetime, timedelta
from typing import Dict, List, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.db.models import AuthorityLedgerEvent, ExecutionMandate, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthorityLedgerWriter:
    """
    Manages authority ledger event recording.
    
    Records all authority-related events including mandate issuance,
    validation attempts, and revocations to an immutable ledger.
    
    Implements:
    - Atomic write operations
    - Monotonically increasing event IDs (handled by database)
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize AuthorityLedgerWriter.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
        logger.info("AuthorityLedgerWriter initialized")
    
    def record_issuance(
        self,
        mandate_id: UUID,
        principal_id: UUID,
        timestamp: Optional[datetime] = None,
        metadata: Optional[Dict] = None,
        correlation_id: Optional[str] = None
    ) -> AuthorityLedgerEvent:
        """
        Record a mandate issuance event.
        
        Creates a ledger event with type="issued" and writes it to the database.
        
        Args:
            mandate_id: The mandate ID that was issued
            principal_id: The principal ID that received the mandate
            timestamp: Optional timestamp (defaults to current UTC time)
            metadata: Optional additional metadata
            correlation_id: Optional correlation ID for request tracking
        
        Returns:
            The created AuthorityLedgerEvent
        
        Raises:
            RuntimeError: If database write fails
        
        """
        if timestamp is None:
            timestamp = datetime.utcnow()
        
        logger.info(
            f"Recording mandate issuance: mandate_id={mandate_id}, "
            f"principal_id={principal_id}"
        )
        
        # Create ledger event
        event = AuthorityLedgerEvent(
            event_type="issued",
            timestamp=timestamp,
            principal_id=principal_id,
            mandate_id=mandate_id,
            decision=None,
            denial_reason=None,
            requested_action=None,
            requested_resource=None,
            event_metadata=metadata,
            correlation_id=correlation_id
        )
        
        # Write to database
        try:
            self.db_session.add(event)
            self.db_session.flush()  # Flush to get the event_id assigned
            logger.info(
                f"Recorded issuance event {event.event_id} for mandate {mandate_id}"
            )
        except Exception as e:
            error_msg = f"Failed to record issuance event to database: {e}"
            logger.error(error_msg, exc_info=True)
            self.db_session.rollback()
            raise RuntimeError(error_msg)
        
        return event
    
    def record_validation(
        self,
        mandate_id: Optional[UUID],
        principal_id: UUID,
        decision: str,
        denial_reason: Optional[str],
        requested_action: str,
        requested_resource: str,
        timestamp: Optional[datetime] = None,
        metadata: Optional[Dict] = None,
        correlation_id: Optional[str] = None
    ) -> AuthorityLedgerEvent:
        """
        Record a mandate validation event.
        
        Creates a ledger event with type="validated" or "denied" based on the
        decision outcome and writes it to the database.
        
        Args:
            mandate_id: The mandate ID that was validated (None if no mandate provided)
            principal_id: The principal ID that attempted the action
            decision: Decision outcome ("allowed" or "denied")
            denial_reason: Reason for denial if applicable (required if decision="denied")
            requested_action: The action that was requested
            requested_resource: The resource that was requested
            timestamp: Optional timestamp (defaults to current UTC time)
            metadata: Optional additional metadata
            correlation_id: Optional correlation ID for request tracking
        
        Returns:
            The created AuthorityLedgerEvent
        
        Raises:
            RuntimeError: If database write fails
            ValueError: If decision is "denied" but no denial_reason provided
        
        """
        if timestamp is None:
            timestamp = datetime.utcnow()
        
        # Validate inputs
        if decision not in ["allowed", "denied"]:
            raise ValueError(f"Invalid decision: {decision}. Must be 'allowed' or 'denied'")
        
        if decision == "denied" and not denial_reason:
            raise ValueError("denial_reason is required when decision is 'denied'")
        
        # Determine event type based on decision
        event_type = "validated" if decision == "allowed" else "denied"
        
        logger.info(
            f"Recording validation event: mandate_id={mandate_id}, "
            f"principal_id={principal_id}, decision={decision}, "
            f"action={requested_action}, resource={requested_resource}"
        )
        
        # Create ledger event
        event = AuthorityLedgerEvent(
            event_type=event_type,
            timestamp=timestamp,
            principal_id=principal_id,
            mandate_id=mandate_id,
            decision=decision,
            denial_reason=denial_reason,
            requested_action=requested_action,
            requested_resource=requested_resource,
            event_metadata=metadata,
            correlation_id=correlation_id
        )
        
        # Write to database
        try:
            self.db_session.add(event)
            self.db_session.flush()  # Flush to get the event_id assigned
            logger.info(
                f"Recorded validation event {event.event_id} for mandate {mandate_id} "
                f"(decision={decision})"
            )
        except Exception as e:
            error_msg = f"Failed to record validation event to database: {e}"
            logger.error(error_msg, exc_info=True)
            self.db_session.rollback()
            raise RuntimeError(error_msg)
        
        return event
    
    def record_revocation(
        self,
        mandate_id: UUID,
        principal_id: UUID,
        reason: str,
        timestamp: Optional[datetime] = None,
        metadata: Optional[Dict] = None,
        correlation_id: Optional[str] = None
    ) -> AuthorityLedgerEvent:
        """
        Record a mandate revocation event.
        
        Creates a ledger event with type="revoked" and writes it to the database.
        
        Args:
            mandate_id: The mandate ID that was revoked
            principal_id: The principal ID that revoked the mandate
            reason: Reason for revocation
            timestamp: Optional timestamp (defaults to current UTC time)
            metadata: Optional additional metadata
            correlation_id: Optional correlation ID for request tracking
        
        Returns:
            The created AuthorityLedgerEvent
        
        Raises:
            RuntimeError: If database write fails
        
        """
        if timestamp is None:
            timestamp = datetime.utcnow()
        
        logger.info(
            f"Recording mandate revocation: mandate_id={mandate_id}, "
            f"principal_id={principal_id}, reason={reason}"
        )
        
        # Create ledger event
        event = AuthorityLedgerEvent(
            event_type="revoked",
            timestamp=timestamp,
            principal_id=principal_id,
            mandate_id=mandate_id,
            decision=None,
            denial_reason=reason,  # Store revocation reason in denial_reason field
            requested_action=None,
            requested_resource=None,
            event_metadata=metadata,
            correlation_id=correlation_id
        )
        
        # Write to database
        try:
            self.db_session.add(event)
            self.db_session.flush()  # Flush to get the event_id assigned
            logger.info(
                f"Recorded revocation event {event.event_id} for mandate {mandate_id}"
            )
        except Exception as e:
            error_msg = f"Failed to record revocation event to database: {e}"
            logger.error(error_msg, exc_info=True)
            self.db_session.rollback()
            raise RuntimeError(error_msg)
        
        return event


class AuthorityLedgerQuery:
    """
    Query service for the authority ledger.
    
    Provides filtering and aggregation capabilities for authority ledger events.
    Uses database queries with indexes for performance.
    
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize AuthorityLedgerQuery.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
        logger.info("AuthorityLedgerQuery initialized")
    
    def get_events(
        self,
        principal_id: Optional[UUID] = None,
        mandate_id: Optional[UUID] = None,
        event_type: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        decision: Optional[str] = None,
        limit: Optional[int] = None
    ) -> List[AuthorityLedgerEvent]:
        """
        Query events with optional filters.
        
        All filters are optional and can be combined. Results are ordered by
        timestamp descending (most recent first).
        
        Args:
            principal_id: Filter by principal ID (optional)
            mandate_id: Filter by mandate ID (optional)
            event_type: Filter by event type (issued, validated, denied, revoked) (optional)
            start_time: Filter events on or after this time (optional)
            end_time: Filter events before or at this time (optional)
            decision: Filter by decision outcome (allowed, denied) (optional)
            limit: Maximum number of events to return (optional)
        
        Returns:
            List of AuthorityLedgerEvent objects matching the filters
        
        Raises:
            RuntimeError: If database query fails
        
        """
        logger.debug(
            f"Querying authority ledger: principal_id={principal_id}, "
            f"mandate_id={mandate_id}, event_type={event_type}, "
            f"start_time={start_time}, end_time={end_time}, "
            f"decision={decision}, limit={limit}"
        )
        
        try:
            # Build query with filters
            query = self.db_session.query(AuthorityLedgerEvent)
            
            if principal_id is not None:
                query = query.filter(AuthorityLedgerEvent.principal_id == principal_id)
            
            if mandate_id is not None:
                query = query.filter(AuthorityLedgerEvent.mandate_id == mandate_id)
            
            if event_type is not None:
                query = query.filter(AuthorityLedgerEvent.event_type == event_type)
            
            if start_time is not None:
                query = query.filter(AuthorityLedgerEvent.timestamp >= start_time)
            
            if end_time is not None:
                query = query.filter(AuthorityLedgerEvent.timestamp <= end_time)
            
            if decision is not None:
                query = query.filter(AuthorityLedgerEvent.decision == decision)
            
            # Order by timestamp descending (most recent first)
            query = query.order_by(AuthorityLedgerEvent.timestamp.desc())
            
            # Apply limit if specified
            if limit is not None:
                query = query.limit(limit)
            
            # Execute query
            events = query.all()
            
            logger.debug(f"Query returned {len(events)} events")
            
            return events
            
        except Exception as e:
            error_msg = f"Failed to query authority ledger: {e}"
            logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg)
    
    def aggregate_by_principal(
        self,
        start_time: datetime,
        end_time: datetime,
        event_type: Optional[str] = None
    ) -> Dict[UUID, int]:
        """
        Aggregate events by principal for a time window.
        
        Returns a dictionary mapping principal_id to event count for the
        specified time range and optional event type filter.
        
        Args:
            start_time: Start of time window (inclusive)
            end_time: End of time window (inclusive)
            event_type: Optional event type filter (issued, validated, denied, revoked)
        
        Returns:
            Dictionary mapping principal_id (UUID) to event count (int)
        
        Raises:
            RuntimeError: If database query fails
        
        """
        logger.debug(
            f"Aggregating events by principal: start_time={start_time}, "
            f"end_time={end_time}, event_type={event_type}"
        )
        
        try:
            # Build query with filters
            query = self.db_session.query(
                AuthorityLedgerEvent.principal_id,
                self.db_session.query(AuthorityLedgerEvent).filter(
                    AuthorityLedgerEvent.principal_id == AuthorityLedgerEvent.principal_id
                ).count().label('event_count')
            )
            
            # Apply time range filter
            query = query.filter(
                AuthorityLedgerEvent.timestamp >= start_time,
                AuthorityLedgerEvent.timestamp <= end_time
            )
            
            # Apply event type filter if specified
            if event_type is not None:
                query = query.filter(AuthorityLedgerEvent.event_type == event_type)
            
            # Group by principal_id
            query = query.group_by(AuthorityLedgerEvent.principal_id)
            
            # Execute query and build result dictionary
            # Use a simpler approach: get all events and count in Python
            events_query = self.db_session.query(AuthorityLedgerEvent).filter(
                AuthorityLedgerEvent.timestamp >= start_time,
                AuthorityLedgerEvent.timestamp <= end_time
            )
            
            if event_type is not None:
                events_query = events_query.filter(AuthorityLedgerEvent.event_type == event_type)
            
            events = events_query.all()
            
            # Count events by principal
            aggregation: Dict[UUID, int] = {}
            for event in events:
                if event.principal_id in aggregation:
                    aggregation[event.principal_id] += 1
                else:
                    aggregation[event.principal_id] = 1
            
            logger.debug(
                f"Aggregated {len(events)} events for {len(aggregation)} principals"
            )
            
            return aggregation
            
        except Exception as e:
            error_msg = f"Failed to aggregate events by principal: {e}"
            logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg)
