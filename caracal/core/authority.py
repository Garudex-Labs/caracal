"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authority evaluation for mandate validation.

This module provides the AuthorityEvaluator class for validating execution
mandates and making allow/deny decisions with fail-closed semantics.

Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 8.7, 8.8, 8.9
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.core.crypto import verify_mandate_signature
from caracal.db.models import ExecutionMandate, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)

# Import AuthorityLedgerWriter and RedisMandateCache for type hints (avoid circular import)
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.redis.mandate_cache import RedisMandateCache


@dataclass
class AuthorityDecision:
    """
    Result of authority validation.
    
    Contains the decision outcome (allowed/denied) and the reason for the decision.
    """
    allowed: bool
    reason: str
    mandate_id: Optional[UUID] = None
    principal_id: Optional[UUID] = None
    requested_action: Optional[str] = None
    requested_resource: Optional[str] = None
    timestamp: Optional[datetime] = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()


class AuthorityEvaluator:
    """
    Evaluates authority for action execution.
    
    Validates mandates and makes allow/deny decisions with fail-closed semantics.
    Any error or uncertainty results in denial of authority.
    
    Requirements: 6.9, 14.4
    """
    
    def __init__(self, db_session: Session, ledger_writer=None, mandate_cache=None):
        """
        Initialize AuthorityEvaluator.
        
        Args:
            db_session: SQLAlchemy database session
            ledger_writer: AuthorityLedgerWriter instance (optional, for recording events)
            mandate_cache: RedisMandateCache instance (optional, for caching mandates)
        """
        self.db_session = db_session
        self.ledger_writer = ledger_writer
        self.mandate_cache = mandate_cache
        logger.info(f"AuthorityEvaluator initialized (cache_enabled={mandate_cache is not None})")
    
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
    
    def _get_mandate_with_cache(self, mandate_id: UUID) -> Optional[ExecutionMandate]:
        """
        Get mandate by ID with caching support.
        
        Checks cache first, falls back to database if not cached.
        
        Args:
            mandate_id: The mandate ID to get
        
        Returns:
            ExecutionMandate if found, None otherwise
        
        Requirements: 14.4
        """
        # Try cache first if available
        if self.mandate_cache:
            try:
                cached_data = self.mandate_cache.get_cached_mandate(mandate_id)
                if cached_data:
                    # Reconstruct ExecutionMandate from cached data
                    mandate = ExecutionMandate(**cached_data)
                    logger.debug(f"Retrieved mandate {mandate_id} from cache")
                    return mandate
            except Exception as e:
                logger.warning(f"Failed to get mandate from cache: {e}")
                # Fall through to database query
        
        # Cache miss or cache not available - query database
        try:
            mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mandate_id
            ).first()
            
            if mandate and self.mandate_cache:
                # Cache the mandate for future use
                try:
                    self.mandate_cache.cache_mandate(mandate)
                except Exception as e:
                    logger.warning(f"Failed to cache mandate: {e}")
            
            return mandate
        except Exception as e:
            logger.error(f"Failed to get mandate {mandate_id}: {e}", exc_info=True)
            return None
    
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
            event_type: Type of event (validated, denied)
            principal_id: Principal ID associated with the event
            mandate_id: Mandate ID if applicable
            decision: Decision outcome (allowed/denied)
            denial_reason: Reason for denial if applicable
            requested_action: Requested action for validation events
            requested_resource: Requested resource for validation events
            metadata: Additional metadata
        """
        if self.ledger_writer:
            try:
                self.ledger_writer.record_validation(
                    mandate_id=mandate_id,
                    principal_id=principal_id,
                    decision=decision,
                    denial_reason=denial_reason,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                    metadata=metadata
                )
            except Exception as e:
                logger.error(f"Failed to record ledger event: {e}", exc_info=True)
        else:
            logger.debug(f"No ledger writer configured, skipping event recording for {event_type}")
    
    def validate_mandate(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        current_time: Optional[datetime] = None
    ) -> AuthorityDecision:
        """
        Validate a mandate for a specific action.
        
        Checks:
        - Cryptographic signature
        - Expiration
        - Revocation status
        - Action scope
        - Resource scope
        - Delegation chain validity
        
        Returns AuthorityDecision with allow/deny and reason.
        Implements fail-closed semantics: any error results in denial.
        
        Args:
            mandate: The ExecutionMandate to validate
            requested_action: The action being requested
            requested_resource: The resource being accessed
            current_time: Optional current time (defaults to utcnow)
        
        Returns:
            AuthorityDecision with allow/deny and reason
        
        Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10
        """
        if current_time is None:
            current_time = datetime.utcnow()
        
        logger.info(
            f"Validating mandate {mandate.mandate_id} for action={requested_action}, "
            f"resource={requested_resource}"
        )
        
        # Fail-closed: If mandate is None, deny
        if mandate is None:
            reason = "No mandate provided"
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=None,
                mandate_id=None,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Check revocation status first (fail fast)
        if mandate.revoked:
            reason = f"Mandate {mandate.mandate_id} is revoked"
            if mandate.revocation_reason:
                reason += f": {mandate.revocation_reason}"
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Check expiration
        if current_time < mandate.valid_from:
            reason = f"Mandate {mandate.mandate_id} is not yet valid (starts at {mandate.valid_from})"
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        if current_time > mandate.valid_until:
            reason = f"Mandate {mandate.mandate_id} has expired (expired at {mandate.valid_until})"
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Verify cryptographic signature
        try:
            issuer = self._get_principal(mandate.issuer_id)
            if not issuer:
                reason = f"Issuer principal {mandate.issuer_id} not found"
                logger.error(reason)
                decision = AuthorityDecision(
                    allowed=False,
                    reason=reason,
                    mandate_id=mandate.mandate_id,
                    principal_id=mandate.subject_id,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                self._record_ledger_event(
                    event_type="denied",
                    principal_id=mandate.subject_id,
                    mandate_id=mandate.mandate_id,
                    decision="denied",
                    denial_reason=reason,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                return decision
            
            if not issuer.public_key_pem:
                reason = f"Issuer principal {mandate.issuer_id} has no public key"
                logger.error(reason)
                decision = AuthorityDecision(
                    allowed=False,
                    reason=reason,
                    mandate_id=mandate.mandate_id,
                    principal_id=mandate.subject_id,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                self._record_ledger_event(
                    event_type="denied",
                    principal_id=mandate.subject_id,
                    mandate_id=mandate.mandate_id,
                    decision="denied",
                    denial_reason=reason,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                return decision
            
            # Reconstruct mandate data for signature verification
            mandate_data = {
                "mandate_id": str(mandate.mandate_id),
                "issuer_id": str(mandate.issuer_id),
                "subject_id": str(mandate.subject_id),
                "valid_from": mandate.valid_from.isoformat(),
                "valid_until": mandate.valid_until.isoformat(),
                "resource_scope": mandate.resource_scope,
                "action_scope": mandate.action_scope,
                "delegation_depth": mandate.delegation_depth,
                "parent_mandate_id": str(mandate.parent_mandate_id) if mandate.parent_mandate_id else None,
                "intent_hash": mandate.intent_hash
            }
            
            signature_valid = verify_mandate_signature(
                mandate_data,
                mandate.signature,
                issuer.public_key_pem
            )
            
            if not signature_valid:
                reason = f"Invalid signature for mandate {mandate.mandate_id}"
                logger.warning(reason)
                decision = AuthorityDecision(
                    allowed=False,
                    reason=reason,
                    mandate_id=mandate.mandate_id,
                    principal_id=mandate.subject_id,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                self._record_ledger_event(
                    event_type="denied",
                    principal_id=mandate.subject_id,
                    mandate_id=mandate.mandate_id,
                    decision="denied",
                    denial_reason=reason,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                return decision
            
        except Exception as e:
            # Fail-closed: Any error in signature verification results in denial
            reason = f"Signature verification failed: {e}"
            logger.error(reason, exc_info=True)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Validate action scope
        action_in_scope = False
        for allowed_action in mandate.action_scope:
            if self._match_pattern(requested_action, allowed_action):
                action_in_scope = True
                break
        
        if not action_in_scope:
            reason = (
                f"Requested action '{requested_action}' is not in mandate scope. "
                f"Allowed actions: {mandate.action_scope}"
            )
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Validate resource scope
        resource_in_scope = False
        for allowed_resource in mandate.resource_scope:
            if self._match_pattern(requested_resource, allowed_resource):
                resource_in_scope = True
                break
        
        if not resource_in_scope:
            reason = (
                f"Requested resource '{requested_resource}' is not in mandate scope. "
                f"Allowed resources: {mandate.resource_scope}"
            )
            logger.warning(reason)
            decision = AuthorityDecision(
                allowed=False,
                reason=reason,
                mandate_id=mandate.mandate_id,
                principal_id=mandate.subject_id,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            self._record_ledger_event(
                event_type="denied",
                principal_id=mandate.subject_id,
                mandate_id=mandate.mandate_id,
                decision="denied",
                denial_reason=reason,
                requested_action=requested_action,
                requested_resource=requested_resource
            )
            return decision
        
        # Validate delegation chain if applicable
        if mandate.parent_mandate_id:
            chain_valid = self.check_delegation_chain(mandate)
            if not chain_valid:
                reason = f"Delegation chain is invalid for mandate {mandate.mandate_id}"
                logger.warning(reason)
                decision = AuthorityDecision(
                    allowed=False,
                    reason=reason,
                    mandate_id=mandate.mandate_id,
                    principal_id=mandate.subject_id,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                self._record_ledger_event(
                    event_type="denied",
                    principal_id=mandate.subject_id,
                    mandate_id=mandate.mandate_id,
                    decision="denied",
                    denial_reason=reason,
                    requested_action=requested_action,
                    requested_resource=requested_resource
                )
                return decision
        
        # All checks passed - allow the action
        reason = f"Mandate {mandate.mandate_id} is valid for action '{requested_action}' on resource '{requested_resource}'"
        logger.info(reason)
        decision = AuthorityDecision(
            allowed=True,
            reason=reason,
            mandate_id=mandate.mandate_id,
            principal_id=mandate.subject_id,
            requested_action=requested_action,
            requested_resource=requested_resource
        )
        self._record_ledger_event(
            event_type="validated",
            principal_id=mandate.subject_id,
            mandate_id=mandate.mandate_id,
            decision="allowed",
            denial_reason=None,
            requested_action=requested_action,
            requested_resource=requested_resource
        )
        return decision
    
    def check_delegation_chain(
        self,
        mandate: ExecutionMandate
    ) -> bool:
        """
        Validate entire delegation chain.
        
        Traverses parent mandates recursively and validates each:
        - Not revoked
        - Not expired
        - Scope constraints maintained
        
        Returns True if chain is valid, False otherwise.
        
        Args:
            mandate: The mandate to check the delegation chain for
        
        Returns:
            True if delegation chain is valid, False otherwise
        
        Requirements: 8.7, 8.8, 8.9
        """
        logger.info(f"Checking delegation chain for mandate {mandate.mandate_id}")
        
        # If no parent, chain is valid (root mandate)
        if not mandate.parent_mandate_id:
            logger.debug(f"Mandate {mandate.mandate_id} is a root mandate (no parent)")
            return True
        
        # Get parent mandate
        try:
            parent_mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mandate.parent_mandate_id
            ).first()
            
            if not parent_mandate:
                logger.warning(f"Parent mandate {mandate.parent_mandate_id} not found")
                return False
            
        except Exception as e:
            # Fail-closed: Any error in database query results in denial
            logger.error(f"Failed to get parent mandate {mandate.parent_mandate_id}: {e}", exc_info=True)
            return False
        
        # Check if parent is revoked
        if parent_mandate.revoked:
            logger.warning(
                f"Parent mandate {parent_mandate.mandate_id} is revoked, "
                f"invalidating child mandate {mandate.mandate_id}"
            )
            return False
        
        # Check if parent is expired
        current_time = datetime.utcnow()
        if current_time > parent_mandate.valid_until:
            logger.warning(
                f"Parent mandate {parent_mandate.mandate_id} is expired, "
                f"invalidating child mandate {mandate.mandate_id}"
            )
            return False
        
        if current_time < parent_mandate.valid_from:
            logger.warning(
                f"Parent mandate {parent_mandate.mandate_id} is not yet valid, "
                f"invalidating child mandate {mandate.mandate_id}"
            )
            return False
        
        # Check scope constraints are maintained
        # Child resource scope must be subset of parent resource scope
        for child_resource in mandate.resource_scope:
            match_found = False
            for parent_resource in parent_mandate.resource_scope:
                if self._match_pattern(child_resource, parent_resource):
                    match_found = True
                    break
            
            if not match_found:
                logger.warning(
                    f"Child mandate {mandate.mandate_id} has resource '{child_resource}' "
                    f"not in parent scope {parent_mandate.resource_scope}"
                )
                return False
        
        # Child action scope must be subset of parent action scope
        for child_action in mandate.action_scope:
            match_found = False
            for parent_action in parent_mandate.action_scope:
                if self._match_pattern(child_action, parent_action):
                    match_found = True
                    break
            
            if not match_found:
                logger.warning(
                    f"Child mandate {mandate.mandate_id} has action '{child_action}' "
                    f"not in parent scope {parent_mandate.action_scope}"
                )
                return False
        
        # Recursively check parent's delegation chain
        parent_chain_valid = self.check_delegation_chain(parent_mandate)
        
        if not parent_chain_valid:
            logger.warning(
                f"Parent mandate {parent_mandate.mandate_id} has invalid delegation chain, "
                f"invalidating child mandate {mandate.mandate_id}"
            )
            return False
        
        logger.info(f"Delegation chain is valid for mandate {mandate.mandate_id}")
        return True
