"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mandate management for authority enforcement.

This module provides the MandateManager class for managing execution mandate
lifecycle including issuance, revocation, and graph-based delegation.

"""

from datetime import datetime, timedelta
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from caracal.core.crypto import sign_mandate
from caracal.core.intent import Intent
from caracal.db.models import ExecutionMandate, AuthorityPolicy, Principal, DelegationEdgeModel
from caracal.logging_config import get_logger

logger = get_logger(__name__)

# Import AuthorityLedgerWriter, RedisMandateCache, and MandateIssuanceRateLimiter for type hints (avoid circular import)
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.redis.mandate_cache import RedisMandateCache
    from caracal.core.rate_limiter import MandateIssuanceRateLimiter


class MandateManager:
    """
    Manages execution mandate lifecycle.
    
    Handles mandate issuance, revocation, and delegation with validation
    against authority policies and fail-closed semantics.
    
    """
    
    def __init__(self, db_session: Session, ledger_writer=None, mandate_cache=None, rate_limiter=None, delegation_graph=None):
        """
        Initialize MandateManager.
        
        Args:
            db_session: SQLAlchemy database session
            ledger_writer: AuthorityLedgerWriter instance (optional, for recording events)
            mandate_cache: RedisMandateCache instance (optional, for caching mandates)
            rate_limiter: MandateIssuanceRateLimiter instance (optional, for rate limiting)
            delegation_graph: DelegationGraph instance (optional, for graph-based delegation)
        """
        self.db_session = db_session
        self.ledger_writer = ledger_writer
        self.mandate_cache = mandate_cache
        self.rate_limiter = rate_limiter
        self.delegation_graph = delegation_graph
        logger.info(
            f"MandateManager initialized (cache_enabled={mandate_cache is not None}, "
            f"rate_limiter_enabled={rate_limiter is not None}, "
            f"delegation_graph_enabled={delegation_graph is not None})"
        )
    
    def _get_active_policy(self, principal_id: UUID) -> Optional[AuthorityPolicy]:
        """
        Get active authority policy for a principal.
        
        Args:
            principal_id: The principal ID to get policy for
        
        Returns:
            AuthorityPolicy if found and active, None otherwise
        """
        try:
            policy = self.db_session.query(AuthorityPolicy).filter(
                AuthorityPolicy.principal_id == principal_id,
                AuthorityPolicy.active == True
            ).first()
            
            return policy
        except Exception as e:
            logger.error(f"Failed to get active policy for principal {principal_id}: {e}", exc_info=True)
            return None
    
    def _get_principal(self, principal_id: UUID) -> Optional[Principal]:
        """
        Get principal by ID.
        
        Args:
            principal_id: The principal ID to get
        
        Returns:
            Principal if found, None otherwise
        """
        try:
            principal = self.db_session.query(Principal).filter(
                Principal.principal_id == principal_id
            ).first()
            
            return principal
        except Exception as e:
            logger.error(f"Failed to get principal {principal_id}: {e}", exc_info=True)
            return None
    
    def _validate_scope_subset(
        self,
        child_scope: List[str],
        parent_scope: List[str]
    ) -> bool:
        """
        Validate that child scope is a subset of parent scope.
        
        Args:
            child_scope: The child scope to validate
            parent_scope: The parent scope to validate against
        
        Returns:
            True if child is subset of parent, False otherwise
        """
        # Every item in child_scope must match at least one pattern in parent_scope
        for child_item in child_scope:
            match_found = False
            for parent_item in parent_scope:
                if self._match_pattern(child_item, parent_item):
                    match_found = True
                    break
            
            if not match_found:
                return False
        
        return True
    
    def _match_pattern(self, value: str, pattern: str) -> bool:
        """
        Check if value matches pattern (supports wildcards).
        
        Args:
            value: The value to match
            pattern: The pattern to match against (supports * wildcard)
        
        Returns:
            True if value matches pattern, False otherwise
        """
        # Exact match
        if value == pattern:
            return True
        
        # Wildcard match
        if '*' in pattern:
            import re
            regex_pattern = pattern.replace('*', '.*')
            regex_pattern = f"^{regex_pattern}$"
            if re.match(regex_pattern, value):
                return True
        
        return False
    
    def _record_ledger_event(
        self,
        event_type: str,
        principal_id: UUID,
        mandate_id: Optional[UUID] = None,
        decision: Optional[str] = None,
        denial_reason: Optional[str] = None,
        requested_action: Optional[str] = None,
        requested_resource: Optional[str] = None,
        metadata: Optional[dict] = None
    ):
        """
        Record an authority ledger event.
        
        Args:
            event_type: Type of event (issued, validated, denied, revoked)
            principal_id: Principal ID associated with the event
            mandate_id: Mandate ID if applicable
            decision: Decision outcome (allowed/denied) for validation events
            denial_reason: Reason for denial if applicable
            requested_action: Requested action for validation events
            requested_resource: Requested resource for validation events
            metadata: Additional metadata
        """
        if self.ledger_writer:
            try:
                if event_type == "issued":
                    self.ledger_writer.record_issuance(
                        mandate_id=mandate_id,
                        principal_id=principal_id,
                        metadata=metadata
                    )
                elif event_type == "revoked":
                    self.ledger_writer.record_revocation(
                        mandate_id=mandate_id,
                        principal_id=principal_id,
                        reason=denial_reason,
                        metadata=metadata
                    )
                else:
                    logger.warning(f"Unknown event type for ledger recording: {event_type}")
            except Exception as e:
                logger.error(f"Failed to record ledger event: {e}", exc_info=True)
        else:
            logger.debug(f"No ledger writer configured, skipping event recording for {event_type}")


    def issue_mandate(
        self,
        issuer_id: UUID,
        subject_id: UUID,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        intent: Optional[Intent] = None,
        delegation_type: str = "hierarchical",
        context_tags: Optional[List[str]] = None,
    ) -> ExecutionMandate:
        """
        Issue a new execution mandate.
        
        Validates:
        - Issuer has authority to issue mandates
        - Scope is within issuer's policy limits
        - Validity period is within policy limits
        
        Args:
            issuer_id: Principal ID of the issuer
            subject_id: Principal ID of the subject receiving the mandate
            resource_scope: List of resource patterns the mandate grants access to
            action_scope: List of actions the mandate allows
            validity_seconds: How long the mandate is valid (in seconds)
            intent: Optional intent to bind the mandate to
            delegation_type: Type of delegation (hierarchical/peer)
            context_tags: Context tags for dynamic authority filtering
        
        Returns:
            Signed ExecutionMandate object
        
        Raises:
            ValueError: If validation fails
            RuntimeError: If mandate creation fails
        
        """
        logger.info(
            f"Issuing mandate: issuer={issuer_id}, subject={subject_id}, "
            f"validity={validity_seconds}s, type={delegation_type}"
        )
        
        # Check rate limit if rate limiter is configured
        if self.rate_limiter:
            try:
                self.rate_limiter.check_rate_limit(issuer_id)
            except Exception as e:
                # Rate limit exceeded
                error_msg = str(e)
                logger.warning(error_msg)
                self._record_ledger_event(
                    event_type="denied",
                    principal_id=issuer_id,
                    decision="denied",
                    denial_reason=error_msg
                )
                raise ValueError(error_msg)
        
        # Validate issuer has active authority policy
        issuer_policy = self._get_active_policy(issuer_id)
        if not issuer_policy:
            error_msg = f"Issuer {issuer_id} does not have an active authority policy"
            logger.warning(error_msg)
            self._record_ledger_event(
                event_type="denied",
                principal_id=issuer_id,
                decision="denied",
                denial_reason=error_msg
            )
            raise ValueError(error_msg)
        
        # Validate requested validity period against policy
        if validity_seconds > issuer_policy.max_validity_seconds:
            error_msg = (
                f"Requested validity {validity_seconds}s exceeds policy limit "
                f"{issuer_policy.max_validity_seconds}s"
            )
            logger.warning(error_msg)
            self._record_ledger_event(
                event_type="denied",
                principal_id=issuer_id,
                decision="denied",
                denial_reason=error_msg
            )
            raise ValueError(error_msg)
        
        # Validate requested scope against policy
        if not self._validate_scope_subset(resource_scope, issuer_policy.allowed_resource_patterns):
            error_msg = "Requested resource scope exceeds policy limits"
            logger.warning(error_msg)
            self._record_ledger_event(
                event_type="denied",
                principal_id=issuer_id,
                decision="denied",
                denial_reason=error_msg
            )
            raise ValueError(error_msg)
        
        if not self._validate_scope_subset(action_scope, issuer_policy.allowed_actions):
            error_msg = "Requested action scope exceeds policy limits"
            logger.warning(error_msg)
            self._record_ledger_event(
                event_type="denied",
                principal_id=issuer_id,
                decision="denied",
                denial_reason=error_msg
            )
            raise ValueError(error_msg)
        
        # Generate unique mandate ID
        mandate_id = uuid4()
        
        # Calculate validity period
        valid_from = datetime.utcnow()
        valid_until = valid_from + timedelta(seconds=validity_seconds)
        
        # Generate intent hash if intent provided
        intent_hash = None
        if intent:
            intent_hash = intent.generate_hash()
        
        # Get issuer principal for signing
        issuer_principal = self._get_principal(issuer_id)
        if not issuer_principal:
            error_msg = f"Issuer principal {issuer_id} not found"
            logger.error(error_msg)
            raise RuntimeError(error_msg)
        
        if not issuer_principal.private_key_pem:
            error_msg = f"Issuer principal {issuer_id} has no private key"
            logger.error(error_msg)
            raise RuntimeError(error_msg)
        
        # Create mandate data for signing
        mandate_data = {
            "mandate_id": str(mandate_id),
            "issuer_id": str(issuer_id),
            "subject_id": str(subject_id),
            "valid_from": valid_from.isoformat(),
            "valid_until": valid_until.isoformat(),
            "resource_scope": resource_scope,
            "action_scope": action_scope,
            "delegation_type": delegation_type,
            "intent_hash": intent_hash
        }
        
        # Sign mandate with issuer's private key
        try:
            signature = sign_mandate(mandate_data, issuer_principal.private_key_pem)
        except Exception as e:
            error_msg = f"Failed to sign mandate: {e}"
            logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg)
        
        # Create mandate object
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=issuer_id,
            subject_id=subject_id,
            valid_from=valid_from,
            valid_until=valid_until,
            resource_scope=resource_scope,
            action_scope=action_scope,
            signature=signature,
            created_at=datetime.utcnow(),
            mandate_metadata={
                "intent_id": str(intent.intent_id) if intent else None,
                "issued_by": "MandateManager"
            },
            revoked=False,
            delegation_type=delegation_type,
            context_tags=context_tags,
            intent_hash=intent_hash
        )
        
        # Store mandate in database
        try:
            self.db_session.add(mandate)
            self.db_session.flush()  # Flush to get the mandate_id assigned
            logger.info(f"Mandate {mandate_id} created and stored in database")
        except Exception as e:
            error_msg = f"Failed to store mandate in database: {e}"
            logger.error(error_msg, exc_info=True)
            self.db_session.rollback()
            raise RuntimeError(error_msg)
        
        # Create authority ledger event
        self._record_ledger_event(
            event_type="issued",
            principal_id=subject_id,
            mandate_id=mandate_id,
            metadata={
                "issuer_id": str(issuer_id),
                "validity_seconds": validity_seconds,
                "delegation_type": delegation_type,
            }
        )
        
        logger.info(
            f"Successfully issued mandate {mandate_id} to subject {subject_id} "
            f"(valid for {validity_seconds}s, type={delegation_type})"
        )
        
        # Record rate limit usage if rate limiter is configured
        if self.rate_limiter:
            try:
                self.rate_limiter.record_request(issuer_id)
            except Exception as e:
                logger.warning(f"Failed to record rate limit: {e}")
        
        return mandate

    def revoke_mandate(
        self,
        mandate_id: UUID,
        revoker_id: UUID,
        reason: str,
        cascade: bool = True
    ) -> None:
        """
        Revoke an execution mandate.
        
        Validates:
        - Revoker has authority to revoke
        - Mandate exists and is not already revoked
        
        If cascade=True, revokes all delegation edges from this mandate.
        
        Args:
            mandate_id: The mandate ID to revoke
            revoker_id: Principal ID of the revoker
            reason: Reason for revocation
            cascade: Whether to revoke delegation edges (default: True)
        
        Raises:
            ValueError: If validation fails
            RuntimeError: If revocation fails
        
        """
        logger.info(
            f"Revoking mandate {mandate_id}: revoker={revoker_id}, "
            f"reason={reason}, cascade={cascade}"
        )
        
        # Get the mandate
        mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == mandate_id
        ).first()
        
        if not mandate:
            error_msg = f"Mandate {mandate_id} not found"
            logger.warning(error_msg)
            raise ValueError(error_msg)
        
        # Check if mandate is already revoked
        if mandate.revoked:
            error_msg = f"Mandate {mandate_id} is already revoked"
            logger.warning(error_msg)
            raise ValueError(error_msg)
        
        # Validate revoker has authority to revoke
        # Revoker must be either:
        # 1. The issuer of the mandate
        # 2. The subject of the mandate (can revoke their own mandate)
        # 3. An admin (has authority policy with revocation rights)
        if revoker_id != mandate.issuer_id and revoker_id != mandate.subject_id:
            # Check if revoker has an authority policy (admin)
            revoker_policy = self._get_active_policy(revoker_id)
            if not revoker_policy:
                error_msg = (
                    f"Revoker {revoker_id} does not have authority to revoke mandate {mandate_id}. "
                    f"Only the issuer, subject, or an admin can revoke a mandate."
                )
                logger.warning(error_msg)
                raise ValueError(error_msg)
        
        # Mark mandate as revoked
        revocation_time = datetime.utcnow()
        mandate.revoked = True
        mandate.revoked_at = revocation_time
        mandate.revocation_reason = reason
        
        try:
            self.db_session.flush()
            logger.info(f"Mandate {mandate_id} marked as revoked")
        except Exception as e:
            error_msg = f"Failed to revoke mandate in database: {e}"
            logger.error(error_msg, exc_info=True)
            self.db_session.rollback()
            raise RuntimeError(error_msg)
        
        # Invalidate cache if available
        if self.mandate_cache:
            try:
                self.mandate_cache.invalidate_mandate(mandate_id)
            except Exception as e:
                logger.warning(f"Failed to invalidate mandate cache: {e}")
        
        # Create authority ledger event for revocation
        self._record_ledger_event(
            event_type="revoked",
            principal_id=revoker_id,
            mandate_id=mandate_id,
            denial_reason=reason,
            metadata={
                "revoker_id": str(revoker_id),
                "revoked_at": revocation_time.isoformat(),
                "cascade": cascade
            }
        )
        
        # If cascade, revoke all delegation edges from this mandate
        cascade_count = 0
        if cascade and self.delegation_graph:
            cascade_count = self.delegation_graph.revoke_cascade(mandate_id, reason)
        
        logger.info(
            f"Successfully revoked mandate {mandate_id} "
            f"(cascade={cascade}, edges_revoked={cascade_count})"
        )

    def delegate_mandate(
        self,
        source_mandate_id: UUID,
        child_subject_id: UUID,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        context_tags: Optional[List[str]] = None,
    ) -> ExecutionMandate:
        """
        Create a delegated mandate from a source mandate.
        
        Creates a new mandate for the child subject with scope that must be
        a subset of the source mandate's scope, then creates a delegation
        edge in the graph. Respects delegation direction rules.
        
        Args:
            source_mandate_id: The source mandate ID to delegate from
            child_subject_id: Principal ID of the child subject
            resource_scope: Resource scope for the child mandate (must be subset)
            action_scope: Action scope for the child mandate (must be subset)
            validity_seconds: Validity period for the child mandate
            context_tags: Optional context tags for the delegation edge
        
        Returns:
            Delegated ExecutionMandate object
        
        Raises:
            ValueError: If validation fails
            RuntimeError: If delegation fails
        """
        from caracal.core.delegation_graph import DelegationGraph
        
        logger.info(
            f"Delegating mandate: source={source_mandate_id}, "
            f"child_subject={child_subject_id}, validity={validity_seconds}s"
        )
        
        # Get source mandate
        source_mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == source_mandate_id
        ).first()
        
        if not source_mandate:
            raise ValueError(f"Source mandate {source_mandate_id} not found")
        if source_mandate.revoked:
            raise ValueError(f"Source mandate {source_mandate_id} is revoked")
        
        current_time = datetime.utcnow()
        if current_time > source_mandate.valid_until:
            raise ValueError(f"Source mandate {source_mandate_id} is expired")
        if current_time < source_mandate.valid_from:
            raise ValueError(f"Source mandate {source_mandate_id} is not yet valid")
        
        # Validate child scope is subset of source scope
        if not self._validate_scope_subset(resource_scope, source_mandate.resource_scope):
            raise ValueError("Child resource scope must be subset of source scope")
        if not self._validate_scope_subset(action_scope, source_mandate.action_scope):
            raise ValueError("Child action scope must be subset of source scope")
        
        # Validate child validity is within source validity
        valid_from = datetime.utcnow()
        valid_until = valid_from + timedelta(seconds=validity_seconds)
        if valid_until > source_mandate.valid_until:
            raise ValueError("Child mandate cannot extend beyond source mandate")
        
        # Get principal types for direction validation
        source_principal = self._get_principal(source_mandate.subject_id)
        target_principal = self._get_principal(child_subject_id)
        
        if not source_principal:
            raise ValueError(f"Source principal {source_mandate.subject_id} not found")
        if not target_principal:
            raise ValueError(f"Target principal {child_subject_id} not found")
        
        # Validate delegation direction
        DelegationGraph.validate_delegation_direction(
            source_principal.principal_type,
            target_principal.principal_type
        )
        
        # Check delegation is allowed by policy
        issuer_policy = self._get_active_policy(source_mandate.subject_id)
        if not issuer_policy:
            raise ValueError(
                f"Subject {source_mandate.subject_id} does not have an active authority policy "
                f"and cannot delegate"
            )
        if not issuer_policy.allow_delegation:
            raise ValueError(
                f"Subject {source_mandate.subject_id} is not allowed to delegate "
                f"according to their authority policy"
            )
        
        # Determine delegation type
        delegation_type = DelegationGraph.get_delegation_type(
            source_principal.principal_type,
            target_principal.principal_type
        )
        
        # Issue the delegated mandate
        try:
            delegated_mandate = self.issue_mandate(
                issuer_id=source_mandate.subject_id,
                subject_id=child_subject_id,
                resource_scope=resource_scope,
                action_scope=action_scope,
                validity_seconds=validity_seconds,
                intent=None,
                delegation_type=delegation_type,
                context_tags=context_tags,
            )
            
            # Create delegation edge in graph
            graph = self.delegation_graph or DelegationGraph(self.db_session)
            graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=delegated_mandate.mandate_id,
                context_tags=context_tags,
                expires_at=delegated_mandate.valid_until,
            )
            
            logger.info(
                f"Successfully delegated mandate {delegated_mandate.mandate_id} "
                f"from source {source_mandate_id} to subject {child_subject_id} "
                f"[{source_principal.principal_type}→{target_principal.principal_type}]"
            )
            
            return delegated_mandate
            
        except (ValueError, RuntimeError):
            raise
        except Exception as e:
            error_msg = f"Failed to delegate mandate: {e}"
            logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg)

    def peer_delegate(
        self,
        source_mandate_id: UUID,
        target_subject_id: UUID,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        context_tags: Optional[List[str]] = None,
    ) -> ExecutionMandate:
        """
        Create a peer delegation — non-hierarchical authority sharing.
        
        Unlike delegate_mandate, peer delegation:
        - Only works between same principal types (user↔user, agent↔agent)
        - Creates a DelegationEdge with type='peer'
        - Both source and target retain their existing authority level
        - Scope must still be a subset of source's scope
        
        Args:
            source_mandate_id: The source mandate ID
            target_subject_id: Principal ID of the peer target
            resource_scope: Resource scope (must be subset of source)
            action_scope: Action scope (must be subset of source)
            validity_seconds: Validity period
            context_tags: Optional context tags
        
        Returns:
            Peer-delegated ExecutionMandate object
        
        Raises:
            ValueError: If types don't match or validation fails
            RuntimeError: If delegation fails
        """
        from caracal.core.delegation_graph import DelegationGraph
        
        # Get source mandate
        source_mandate = self.db_session.query(ExecutionMandate).filter(
            ExecutionMandate.mandate_id == source_mandate_id
        ).first()
        if not source_mandate:
            raise ValueError(f"Source mandate {source_mandate_id} not found")
        
        # Get principal types
        source_principal = self._get_principal(source_mandate.subject_id)
        target_principal = self._get_principal(target_subject_id)
        
        if not source_principal:
            raise ValueError(f"Source principal {source_mandate.subject_id} not found")
        if not target_principal:
            raise ValueError(f"Target principal {target_subject_id} not found")
        
        # Peer delegation requires same principal type
        if source_principal.principal_type != target_principal.principal_type:
            raise ValueError(
                f"Peer delegation requires same principal types. "
                f"Got {source_principal.principal_type} → {target_principal.principal_type}"
            )
        
        # Validate direction (same type peer must be allowed)
        DelegationGraph.validate_delegation_direction(
            source_principal.principal_type,
            target_principal.principal_type
        )
        
        # Delegate using the standard flow (will set type='peer' automatically)
        return self.delegate_mandate(
            source_mandate_id=source_mandate_id,
            child_subject_id=target_subject_id,
            resource_scope=resource_scope,
            action_scope=action_scope,
            validity_seconds=validity_seconds,
            context_tags=context_tags,
        )
