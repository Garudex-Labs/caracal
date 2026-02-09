"""
Mandate management for authority enforcement.

This module provides the MandateManager class for managing execution mandate
lifecycle including issuance, revocation, and delegation.

Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 7.1, 7.2, 7.3, 7.4,
7.5, 7.7, 7.8, 7.9, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
"""

from datetime import datetime, timedelta
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from caracal.core.crypto import sign_mandate
from caracal.core.intent import Intent
from caracal.db.models import ExecutionMandate, AuthorityPolicy, Principal
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MandateManager:
    """
    Manages execution mandate lifecycle.
    
    Handles mandate issuance, revocation, and delegation with validation
    against authority policies and fail-closed semantics.
    
    Requirements: 5.1, 5.2, 5.3
    """
    
    def __init__(self, db_session: Session, ledger_writer=None):
        """
        Initialize MandateManager.
        
        Args:
            db_session: SQLAlchemy database session
            ledger_writer: AuthorityLedgerWriter instance (optional, for recording events)
        """
        self.db_session = db_session
        self.ledger_writer = ledger_writer
        logger.info("MandateManager initialized")
    
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
        parent_mandate_id: Optional[UUID] = None
    ) -> ExecutionMandate:
        """
        Issue a new execution mandate.
        
        Validates:
        - Issuer has authority to issue mandates
        - Scope is within issuer's policy limits
        - Validity period is within policy limits
        - If delegated, scope/validity is subset of parent
        
        Args:
            issuer_id: Principal ID of the issuer
            subject_id: Principal ID of the subject receiving the mandate
            resource_scope: List of resource patterns the mandate grants access to
            action_scope: List of actions the mandate allows
            validity_seconds: How long the mandate is valid (in seconds)
            intent: Optional intent to bind the mandate to
            parent_mandate_id: Optional parent mandate ID for delegation
        
        Returns:
            Signed ExecutionMandate object
        
        Raises:
            ValueError: If validation fails
            RuntimeError: If mandate creation fails
        
        Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10
        """
        logger.info(
            f"Issuing mandate: issuer={issuer_id}, subject={subject_id}, "
            f"validity={validity_seconds}s, parent={parent_mandate_id}"
        )
        
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
        
        # If this is a delegation, validate against parent mandate
        delegation_depth = 0
        if parent_mandate_id:
            parent_mandate = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == parent_mandate_id
            ).first()
            
            if not parent_mandate:
                error_msg = f"Parent mandate {parent_mandate_id} not found"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            # Validate parent mandate is not revoked
            if parent_mandate.revoked:
                error_msg = f"Parent mandate {parent_mandate_id} is revoked"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            # Validate parent mandate is not expired
            current_time = datetime.utcnow()
            if current_time > parent_mandate.valid_until:
                error_msg = f"Parent mandate {parent_mandate_id} is expired"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            # Validate child scope is subset of parent scope
            if not self._validate_scope_subset(resource_scope, parent_mandate.resource_scope):
                error_msg = "Child resource scope must be subset of parent scope"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            if not self._validate_scope_subset(action_scope, parent_mandate.action_scope):
                error_msg = "Child action scope must be subset of parent scope"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            # Validate child validity is within parent validity
            valid_from = datetime.utcnow()
            valid_until = valid_from + timedelta(seconds=validity_seconds)
            
            if valid_from < parent_mandate.valid_from:
                error_msg = "Child mandate cannot start before parent mandate"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            if valid_until > parent_mandate.valid_until:
                error_msg = "Child mandate cannot extend beyond parent mandate"
                logger.warning(error_msg)
                raise ValueError(error_msg)
            
            # Calculate delegation depth
            delegation_depth = parent_mandate.delegation_depth + 1
            
            # Validate delegation depth is within limits
            if delegation_depth > issuer_policy.max_delegation_depth:
                error_msg = (
                    f"Delegation depth {delegation_depth} exceeds policy limit "
                    f"{issuer_policy.max_delegation_depth}"
                )
                logger.warning(error_msg)
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
            "delegation_depth": delegation_depth,
            "parent_mandate_id": str(parent_mandate_id) if parent_mandate_id else None,
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
            metadata={
                "intent_id": str(intent.intent_id) if intent else None,
                "issued_by": "MandateManager"
            },
            revoked=False,
            parent_mandate_id=parent_mandate_id,
            delegation_depth=delegation_depth,
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
                "delegation_depth": delegation_depth,
                "parent_mandate_id": str(parent_mandate_id) if parent_mandate_id else None
            }
        )
        
        logger.info(
            f"Successfully issued mandate {mandate_id} to subject {subject_id} "
            f"(valid for {validity_seconds}s, delegation_depth={delegation_depth})"
        )
        
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
        
        If cascade=True, revokes all child mandates recursively.
        
        Args:
            mandate_id: The mandate ID to revoke
            revoker_id: Principal ID of the revoker
            reason: Reason for revocation
            cascade: Whether to revoke child mandates (default: True)
        
        Raises:
            ValueError: If validation fails
            RuntimeError: If revocation fails
        
        Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9
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
        
        # If cascade is enabled, revoke all child mandates recursively
        if cascade:
            child_mandates = self.db_session.query(ExecutionMandate).filter(
                ExecutionMandate.parent_mandate_id == mandate_id,
                ExecutionMandate.revoked == False
            ).all()
            
            if child_mandates:
                logger.info(
                    f"Cascade revocation: found {len(child_mandates)} child mandates "
                    f"for mandate {mandate_id}"
                )
                
                for child_mandate in child_mandates:
                    try:
                        # Recursively revoke child mandate
                        self.revoke_mandate(
                            mandate_id=child_mandate.mandate_id,
                            revoker_id=revoker_id,
                            reason=f"Parent mandate {mandate_id} revoked: {reason}",
                            cascade=True
                        )
                    except Exception as e:
                        logger.error(
                            f"Failed to revoke child mandate {child_mandate.mandate_id}: {e}",
                            exc_info=True
                        )
                        # Continue revoking other children even if one fails
        
        logger.info(
            f"Successfully revoked mandate {mandate_id} "
            f"(cascade={cascade}, children_revoked={len(child_mandates) if cascade else 0})"
        )
