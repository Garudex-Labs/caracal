"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Database query optimization utilities.

Provides query result caching, optimized query patterns, and performance
monitoring for database operations.

"""

from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from uuid import UUID

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload, selectinload

from caracal.db.models import ExecutionMandate, AuthorityLedgerEvent, AuthorityPolicy, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class QueryOptimizer:
    """
    Provides optimized database query patterns.
    
    Implements:
    - Eager loading for relationships
    - Batch queries to reduce N+1 problems
    - Query result caching (in-memory)
    - Index-aware query patterns
    
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize query optimizer.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
        self._query_cache: Dict[str, tuple[Any, datetime]] = {}
        self._cache_ttl_seconds = 60  # 1 minute cache TTL
        logger.info("QueryOptimizer initialized")
    
    def _get_cached_result(self, cache_key: str) -> Optional[Any]:
        """
        Get cached query result if available and not expired.
        
        Args:
            cache_key: Cache key
        
        Returns:
            Cached result if available, None otherwise
        """
        if cache_key in self._query_cache:
            result, cached_at = self._query_cache[cache_key]
            age_seconds = (datetime.utcnow() - cached_at).total_seconds()
            
            if age_seconds < self._cache_ttl_seconds:
                logger.debug(f"Query cache hit: {cache_key} (age={age_seconds:.1f}s)")
                return result
            else:
                # Expired, remove from cache
                del self._query_cache[cache_key]
                logger.debug(f"Query cache expired: {cache_key}")
        
        return None
    
    def _cache_result(self, cache_key: str, result: Any) -> None:
        """
        Cache query result.
        
        Args:
            cache_key: Cache key
            result: Query result to cache
        """
        self._query_cache[cache_key] = (result, datetime.utcnow())
        logger.debug(f"Query result cached: {cache_key}")
    
    def get_mandate_with_relationships(self, mandate_id: UUID) -> Optional[ExecutionMandate]:
        """
        Get mandate with eager-loaded relationships.
        
        Uses joinedload to fetch issuer and subject in single query,
        avoiding N+1 query problem.
        
        Args:
            mandate_id: Mandate identifier
        
        Returns:
            ExecutionMandate with relationships loaded, or None
        
        """
        try:
            mandate = self.db_session.query(ExecutionMandate).options(
                joinedload(ExecutionMandate.issuer),
                joinedload(ExecutionMandate.subject),
                joinedload(ExecutionMandate.parent_mandate)
            ).filter(
                ExecutionMandate.mandate_id == mandate_id
            ).first()
            
            return mandate
        except Exception as e:
            logger.error(f"Failed to get mandate with relationships: {e}", exc_info=True)
            return None
    
    def get_active_mandates_for_subject(
        self,
        subject_id: UUID,
        current_time: Optional[datetime] = None
    ) -> List[ExecutionMandate]:
        """
        Get all active (non-revoked, non-expired) mandates for a subject.
        
        Uses optimized query with indexes on:
        - subject_id
        - revoked
        - valid_from
        - valid_until
        
        Args:
            subject_id: Subject principal identifier
            current_time: Current time (defaults to utcnow)
        
        Returns:
            List of active ExecutionMandate objects
        
        """
        if current_time is None:
            current_time = datetime.utcnow()
        
        try:
            mandates = self.db_session.query(ExecutionMandate).filter(
                and_(
                    ExecutionMandate.subject_id == subject_id,
                    ExecutionMandate.revoked == False,
                    ExecutionMandate.valid_from <= current_time,
                    ExecutionMandate.valid_until >= current_time
                )
            ).all()
            
            logger.debug(
                f"Found {len(mandates)} active mandates for subject {subject_id}"
            )
            return mandates
        except Exception as e:
            logger.error(f"Failed to get active mandates: {e}", exc_info=True)
            return []
    
    def get_mandates_expiring_soon(
        self,
        hours: int = 24,
        limit: int = 100
    ) -> List[ExecutionMandate]:
        """
        Get mandates expiring within specified hours.
        
        Useful for proactive notifications or renewal workflows.
        
        Args:
            hours: Number of hours to look ahead
            limit: Maximum number of results
        
        Returns:
            List of ExecutionMandate objects expiring soon
        
        """
        try:
            current_time = datetime.utcnow()
            expiry_threshold = current_time + timedelta(hours=hours)
            
            mandates = self.db_session.query(ExecutionMandate).filter(
                and_(
                    ExecutionMandate.revoked == False,
                    ExecutionMandate.valid_until >= current_time,
                    ExecutionMandate.valid_until <= expiry_threshold
                )
            ).order_by(
                ExecutionMandate.valid_until.asc()
            ).limit(limit).all()
            
            logger.debug(
                f"Found {len(mandates)} mandates expiring within {hours} hours"
            )
            return mandates
        except Exception as e:
            logger.error(f"Failed to get expiring mandates: {e}", exc_info=True)
            return []
    
    def get_authority_events_in_range(
        self,
        start_time: datetime,
        end_time: datetime,
        principal_id: Optional[UUID] = None,
        event_type: Optional[str] = None,
        limit: int = 1000
    ) -> List[AuthorityLedgerEvent]:
        """
        Get authority ledger events in time range with optional filters.
        
        Uses optimized query with indexes on:
        - timestamp
        - principal_id
        - event_type
        
        Args:
            start_time: Start of time range
            end_time: End of time range
            principal_id: Optional principal filter
            event_type: Optional event type filter
            limit: Maximum number of results
        
        Returns:
            List of AuthorityLedgerEvent objects
        
        """
        try:
            query = self.db_session.query(AuthorityLedgerEvent).filter(
                and_(
                    AuthorityLedgerEvent.timestamp >= start_time,
                    AuthorityLedgerEvent.timestamp <= end_time
                )
            )
            
            if principal_id:
                query = query.filter(AuthorityLedgerEvent.principal_id == principal_id)
            
            if event_type:
                query = query.filter(AuthorityLedgerEvent.event_type == event_type)
            
            events = query.order_by(
                AuthorityLedgerEvent.timestamp.desc()
            ).limit(limit).all()
            
            logger.debug(
                f"Found {len(events)} authority events in range "
                f"({start_time} to {end_time})"
            )
            return events
        except Exception as e:
            logger.error(f"Failed to get authority events: {e}", exc_info=True)
            return []
    
    def get_active_policy_for_principal(
        self,
        principal_id: UUID
    ) -> Optional[AuthorityPolicy]:
        """
        Get active authority policy for a principal with caching.
        
        Uses query result caching since policies change infrequently.
        
        Args:
            principal_id: Principal identifier
        
        Returns:
            AuthorityPolicy if found and active, None otherwise
        
        """
        cache_key = f"policy:{principal_id}"
        
        # Check cache first
        cached_policy = self._get_cached_result(cache_key)
        if cached_policy is not None:
            return cached_policy
        
        try:
            policy = self.db_session.query(AuthorityPolicy).filter(
                and_(
                    AuthorityPolicy.principal_id == principal_id,
                    AuthorityPolicy.active == True
                )
            ).first()
            
            # Cache the result (even if None)
            self._cache_result(cache_key, policy)
            
            return policy
        except Exception as e:
            logger.error(f"Failed to get active policy: {e}", exc_info=True)
            return None
    
    def invalidate_policy_cache(self, principal_id: UUID) -> None:
        """
        Invalidate cached policy for a principal.
        
        Should be called when policy is updated or deactivated.
        
        Args:
            principal_id: Principal identifier
        """
        cache_key = f"policy:{principal_id}"
        if cache_key in self._query_cache:
            del self._query_cache[cache_key]
            logger.debug(f"Invalidated policy cache for principal {principal_id}")
    
    def get_delegation_chain(
        self,
        mandate_id: UUID,
        max_depth: int = 10
    ) -> List[ExecutionMandate]:
        """
        Get complete delegation chain for a mandate.
        
        Traverses parent mandates recursively up to max_depth.
        Returns list ordered from root to leaf (child mandate last).
        
        Args:
            mandate_id: Mandate identifier
            max_depth: Maximum delegation depth to traverse
        
        Returns:
            List of ExecutionMandate objects in delegation chain
        
        """
        try:
            chain = []
            current_mandate_id = mandate_id
            depth = 0
            
            while current_mandate_id and depth < max_depth:
                mandate = self.db_session.query(ExecutionMandate).filter(
                    ExecutionMandate.mandate_id == current_mandate_id
                ).first()
                
                if not mandate:
                    break
                
                chain.insert(0, mandate)  # Insert at beginning to maintain order
                current_mandate_id = mandate.parent_mandate_id
                depth += 1
            
            logger.debug(
                f"Retrieved delegation chain for mandate {mandate_id}: "
                f"{len(chain)} mandates"
            )
            return chain
        except Exception as e:
            logger.error(f"Failed to get delegation chain: {e}", exc_info=True)
            return []
    
    def count_active_mandates_by_issuer(
        self,
        issuer_id: UUID,
        current_time: Optional[datetime] = None
    ) -> int:
        """
        Count active mandates issued by a principal.
        
        Useful for monitoring and rate limiting.
        
        Args:
            issuer_id: Issuer principal identifier
            current_time: Current time (defaults to utcnow)
        
        Returns:
            Count of active mandates
        
        """
        if current_time is None:
            current_time = datetime.utcnow()
        
        try:
            count = self.db_session.query(ExecutionMandate).filter(
                and_(
                    ExecutionMandate.issuer_id == issuer_id,
                    ExecutionMandate.revoked == False,
                    ExecutionMandate.valid_from <= current_time,
                    ExecutionMandate.valid_until >= current_time
                )
            ).count()
            
            return count
        except Exception as e:
            logger.error(f"Failed to count active mandates: {e}", exc_info=True)
            return 0
    
    def get_recent_validation_events(
        self,
        mandate_id: UUID,
        limit: int = 10
    ) -> List[AuthorityLedgerEvent]:
        """
        Get recent validation events for a mandate.
        
        Useful for monitoring mandate usage patterns.
        
        Args:
            mandate_id: Mandate identifier
            limit: Maximum number of results
        
        Returns:
            List of recent AuthorityLedgerEvent objects
        
        """
        try:
            events = self.db_session.query(AuthorityLedgerEvent).filter(
                and_(
                    AuthorityLedgerEvent.mandate_id == mandate_id,
                    or_(
                        AuthorityLedgerEvent.event_type == "validated",
                        AuthorityLedgerEvent.event_type == "denied"
                    )
                )
            ).order_by(
                AuthorityLedgerEvent.timestamp.desc()
            ).limit(limit).all()
            
            return events
        except Exception as e:
            logger.error(f"Failed to get validation events: {e}", exc_info=True)
            return []
    
    def clear_cache(self) -> None:
        """Clear all cached query results."""
        self._query_cache.clear()
        logger.info("Query cache cleared")
