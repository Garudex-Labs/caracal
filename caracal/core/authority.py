"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authority evaluation for mandate validation.

This module provides the AuthorityEvaluator class for validating execution
mandates and making allow/deny decisions with fail-closed semantics.
"""

from dataclasses import dataclass
from datetime import datetime
from fnmatch import fnmatchcase
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.core.crypto import verify_mandate_signature
from caracal.core.caveat_chain import (
    CaveatChainError,
    evaluate_caveat_chain,
    verify_caveat_chain,
)
from caracal.db.models import ExecutionMandate, Principal
from caracal.logging_config import get_logger
from caracal.provider.definitions import parse_provider_scope

logger = get_logger(__name__)

# Canonical authorization decision API used by SDK, CLI, and TUI parity flows.
CANONICAL_AUTHORITY_VALIDATION_METHODS = ("validate_mandate",)


class AuthorityBoundaryStage:
    """Boundary-2 validation stages used for telemetry and deny diagnostics."""

    ISSUER_AUTHORITY_CHECKS = "issuer_authority_checks"
    MANDATE_STATE_VALIDATION = "mandate_state_validation"
    DELEGATION_PATH_VALIDATION = "delegation_path_validation"
    SUBJECT_BINDING_VALIDATION = "subject_binding_validation"
    CAVEAT_CHAIN_VALIDATION = "caveat_chain_validation"
    ACTION_RESOURCE_AUTHORIZATION_CHECKS = "action_resource_authorization_checks"
    ALLOW = "allow"


class AuthorityReasonCode:
    """Stable reason codes for authority decisions."""

    ALLOW = "AUTH_ALLOW"
    MANDATE_MISSING = "AUTH_MANDATE_MISSING"
    MANDATE_REVOKED = "AUTH_MANDATE_REVOKED"
    MANDATE_NOT_YET_VALID = "AUTH_MANDATE_NOT_YET_VALID"
    MANDATE_EXPIRED = "AUTH_MANDATE_EXPIRED"
    SUBJECT_BINDING_DENIED = "AUTH_SUBJECT_BINDING_DENIED"
    ISSUER_NOT_FOUND = "AUTH_ISSUER_NOT_FOUND"
    ISSUER_KEY_MISSING = "AUTH_ISSUER_KEY_MISSING"
    SIGNATURE_INVALID = "AUTH_SIGNATURE_INVALID"
    SIGNATURE_VERIFICATION_ERROR = "AUTH_SIGNATURE_VERIFICATION_ERROR"
    ACTION_SCOPE_DENIED = "AUTH_ACTION_SCOPE_DENIED"
    RESOURCE_SCOPE_DENIED = "AUTH_RESOURCE_SCOPE_DENIED"
    DELEGATION_PATH_INVALID = "AUTH_DELEGATION_PATH_INVALID"
    CAVEAT_CHAIN_DENIED = "AUTH_CAVEAT_CHAIN_DENIED"

# Import for type hints (avoid circular import)
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.redis.mandate_cache import RedisMandateCache
    from caracal.core.delegation_graph import DelegationGraph


@dataclass
class AuthorityDecision:
    """
    Result of authority validation.
    
    Contains the decision outcome (allowed/denied) and the reason for the decision.
    """
    allowed: bool
    reason: str
    reason_code: Optional[str] = None
    boundary_stage: Optional[str] = None
    mandate_id: Optional[UUID] = None
    principal_id: Optional[UUID] = None
    requested_action: Optional[str] = None
    requested_resource: Optional[str] = None
    timestamp: Optional[datetime] = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.reason_code is None:
            self.reason_code = AuthorityReasonCode.ALLOW if self.allowed else "AUTH_DENY"


class AuthorityEvaluator:
    """
    Evaluates authority for action execution.

    Validates mandates and makes allow/deny decisions with fail-closed semantics.
    Any error or uncertainty results in denial of authority.
    """
    
    def __init__(self, db_session: Session, ledger_writer=None, mandate_cache=None, delegation_graph=None):
        """
        Initialize AuthorityEvaluator.
        
        Args:
            db_session: SQLAlchemy database session
            ledger_writer: AuthorityLedgerWriter instance (optional, for recording events)
            mandate_cache: RedisMandateCache instance (optional, for caching mandates)
            delegation_graph: DelegationGraph instance (optional, for graph-based path validation)
        """
        self.db_session = db_session
        self.ledger_writer = ledger_writer
        self.mandate_cache = mandate_cache
        self.delegation_graph = delegation_graph
        self._active_caller_principal_id: Optional[str] = None
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

    def resolve_mandate_for_principal(
        self,
        *,
        requested_action: str,
        requested_resource: str,
        caller_principal_id: Optional[str],
        current_time: Optional[datetime] = None,
        caveat_chain: Optional[list[dict[str, Any]]] = None,
        caveat_hmac_key: Optional[str] = None,
        caveat_task_id: Optional[str] = None,
    ) -> Optional[ExecutionMandate]:
        """Resolve the most applicable active mandate for a caller principal.

        Resolution is internal and principal-driven: callers do not provide mandate IDs.
        This helper narrows candidates by subject binding, active time window, and
        action/resource scope match before returning a candidate for full validation.
        """
        del caveat_chain, caveat_hmac_key, caveat_task_id

        resolved_caller = self._normalize_principal_id(caller_principal_id)
        if not resolved_caller:
            logger.warning("Cannot resolve mandate: caller principal ID is missing")
            return None

        try:
            caller_uuid = UUID(str(resolved_caller))
        except Exception:
            logger.warning(
                "Cannot resolve mandate: caller principal ID is not a valid UUID "
                f"({resolved_caller})"
            )
            return None

        evaluation_time = current_time or datetime.utcnow()
        try:
            candidate_mandates = (
                self.db_session.query(ExecutionMandate)
                .filter(
                    ExecutionMandate.subject_id == caller_uuid,
                    ExecutionMandate.revoked.is_(False),
                    ExecutionMandate.valid_from <= evaluation_time,
                    ExecutionMandate.valid_until >= evaluation_time,
                )
                .order_by(
                    ExecutionMandate.valid_until.asc(),
                    ExecutionMandate.created_at.desc(),
                )
                .all()
            )
        except Exception as exc:
            logger.error(
                "Failed to resolve mandates for caller principal "
                f"{resolved_caller}: {exc}",
                exc_info=True,
            )
            return None

        for mandate in candidate_mandates:
            allowed_actions = list(getattr(mandate, "action_scope", []) or [])
            allowed_resources = list(getattr(mandate, "resource_scope", []) or [])

            action_match = any(
                self._match_pattern(str(requested_action), str(allowed_action))
                for allowed_action in allowed_actions
            )
            if not action_match:
                continue

            resource_match = any(
                self._match_pattern(str(requested_resource), str(allowed_resource))
                for allowed_resource in allowed_resources
            )
            if not resource_match:
                continue

            logger.debug(
                "Resolved mandate %s for caller %s action=%s resource=%s",
                getattr(mandate, "mandate_id", None),
                resolved_caller,
                requested_action,
                requested_resource,
            )
            return mandate

        logger.warning(
            "No applicable mandate resolved for caller %s action=%s resource=%s",
            resolved_caller,
            requested_action,
            requested_resource,
        )
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
        # Canonical provider scopes are exact-match only.
        if self._is_canonical_provider_scope(value) or self._is_canonical_provider_scope(pattern):
            return value == pattern

        # Exact match
        if value == pattern:
            return True

        # Non-provider scopes can use shell-style wildcard matching.
        return fnmatchcase(value, pattern)

    @staticmethod
    def _normalize_principal_id(raw_principal_id: Any) -> str:
        normalized = str(raw_principal_id or "").strip()
        if not normalized:
            return ""
        try:
            return str(UUID(normalized))
        except Exception:
            return normalized

    @staticmethod
    def _is_canonical_provider_scope(scope: str) -> bool:
        try:
            parse_provider_scope(str(scope))
            return True
        except Exception:
            return False
    
    def _record_ledger_event(
        self,
        event_type: str,
        principal_id: Optional[UUID],
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

    def _deny_decision(
        self,
        *,
        reason: str,
        reason_code: str,
        boundary_stage: str,
        mandate: Optional[ExecutionMandate],
        requested_action: str,
        requested_resource: str,
        caller_principal_id: Optional[str] = None,
    ) -> AuthorityDecision:
        """Create a denied decision and emit stage-aware ledger telemetry."""
        resolved_caller = caller_principal_id or self._active_caller_principal_id
        decision = AuthorityDecision(
            allowed=False,
            reason=reason,
            reason_code=reason_code,
            boundary_stage=boundary_stage,
            mandate_id=mandate.mandate_id if mandate else None,
            principal_id=mandate.subject_id if mandate else None,
            requested_action=requested_action,
            requested_resource=requested_resource,
        )
        self._record_ledger_event(
            event_type="denied",
            principal_id=decision.principal_id,
            mandate_id=decision.mandate_id,
            decision="denied",
            denial_reason=reason,
            requested_action=requested_action,
            requested_resource=requested_resource,
            metadata={
                "boundary_stage": boundary_stage,
                "reason_code": reason_code,
                "caller_principal_id": resolved_caller,
                "mandate_subject_id": str(mandate.subject_id) if mandate else None,
            },
        )
        return decision

    def _allow_decision(
        self,
        *,
        reason: str,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        caller_principal_id: Optional[str] = None,
    ) -> AuthorityDecision:
        """Create an allow decision and emit stage-aware ledger telemetry."""
        resolved_caller = caller_principal_id or self._active_caller_principal_id
        decision = AuthorityDecision(
            allowed=True,
            reason=reason,
            reason_code=AuthorityReasonCode.ALLOW,
            boundary_stage=AuthorityBoundaryStage.ALLOW,
            mandate_id=mandate.mandate_id,
            principal_id=mandate.subject_id,
            requested_action=requested_action,
            requested_resource=requested_resource,
        )
        self._record_ledger_event(
            event_type="validated",
            principal_id=mandate.subject_id,
            mandate_id=mandate.mandate_id,
            decision="allowed",
            denial_reason=None,
            requested_action=requested_action,
            requested_resource=requested_resource,
            metadata={
                "boundary_stage": AuthorityBoundaryStage.ALLOW,
                "reason_code": AuthorityReasonCode.ALLOW,
                "caller_principal_id": resolved_caller,
                "mandate_subject_id": str(mandate.subject_id),
            },
        )
        return decision

    def _validate_mandate_state(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        current_time: datetime,
    ) -> Optional[AuthorityDecision]:
        """Stage 2: mandate state validation."""
        if mandate.revoked:
            reason = f"Mandate {mandate.mandate_id} is revoked"
            if mandate.revocation_reason:
                reason += f": {mandate.revocation_reason}"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.MANDATE_REVOKED,
                boundary_stage=AuthorityBoundaryStage.MANDATE_STATE_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

        if current_time < mandate.valid_from:
            reason = f"Mandate {mandate.mandate_id} is not yet valid (starts at {mandate.valid_from})"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.MANDATE_NOT_YET_VALID,
                boundary_stage=AuthorityBoundaryStage.MANDATE_STATE_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

        if current_time > mandate.valid_until:
            reason = f"Mandate {mandate.mandate_id} has expired (expired at {mandate.valid_until})"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.MANDATE_EXPIRED,
                boundary_stage=AuthorityBoundaryStage.MANDATE_STATE_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

        return None

    def _validate_subject_binding_stage(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        caller_principal_id: Optional[str],
    ) -> Optional[AuthorityDecision]:
        """Stage 2.5: optional caller-to-subject binding check.

        When caller identity is supplied by the control surface, enforce that
        authority can only be exercised by the mandate subject.
        """
        caller = self._normalize_principal_id(caller_principal_id)
        if not caller:
            return None

        subject = self._normalize_principal_id(getattr(mandate, "subject_id", None))
        if not subject:
            reason = f"Mandate {mandate.mandate_id} has no resolvable subject identity"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.SUBJECT_BINDING_DENIED,
                boundary_stage=AuthorityBoundaryStage.SUBJECT_BINDING_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
                caller_principal_id=caller_principal_id,
            )

        if caller != subject:
            reason = (
                "Authenticated principal does not match mandate subject: "
                f"caller={caller}, subject={subject}"
            )
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.SUBJECT_BINDING_DENIED,
                boundary_stage=AuthorityBoundaryStage.SUBJECT_BINDING_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
                caller_principal_id=caller_principal_id,
            )

        return None

    def _validate_issuer_authority(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
    ) -> Optional[AuthorityDecision]:
        """Stage 1: issuer lookup and signature verification."""
        try:
            issuer = self._get_principal(mandate.issuer_id)
            if not issuer:
                reason = f"Issuer principal {mandate.issuer_id} not found"
                logger.error(reason)
                return self._deny_decision(
                    reason=reason,
                    reason_code=AuthorityReasonCode.ISSUER_NOT_FOUND,
                    boundary_stage=AuthorityBoundaryStage.ISSUER_AUTHORITY_CHECKS,
                    mandate=mandate,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                )

            if not issuer.public_key_pem:
                reason = f"Issuer principal {mandate.issuer_id} has no public key"
                logger.error(reason)
                return self._deny_decision(
                    reason=reason,
                    reason_code=AuthorityReasonCode.ISSUER_KEY_MISSING,
                    boundary_stage=AuthorityBoundaryStage.ISSUER_AUTHORITY_CHECKS,
                    mandate=mandate,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                )

            mandate_data = {
                "mandate_id": str(mandate.mandate_id),
                "issuer_id": str(mandate.issuer_id),
                "subject_id": str(mandate.subject_id),
                "valid_from": mandate.valid_from.isoformat(),
                "valid_until": mandate.valid_until.isoformat(),
                "resource_scope": mandate.resource_scope,
                "action_scope": mandate.action_scope,
                "delegation_type": mandate.delegation_type,
                "intent_hash": mandate.intent_hash,
            }
            signature_valid = verify_mandate_signature(
                mandate_data,
                mandate.signature,
                issuer.public_key_pem,
            )
            if not signature_valid:
                reason = f"Invalid signature for mandate {mandate.mandate_id}"
                logger.warning(reason)
                return self._deny_decision(
                    reason=reason,
                    reason_code=AuthorityReasonCode.SIGNATURE_INVALID,
                    boundary_stage=AuthorityBoundaryStage.ISSUER_AUTHORITY_CHECKS,
                    mandate=mandate,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                )

            return None
        except Exception as exc:
            reason = f"Signature verification failed: {exc}"
            logger.error(reason, exc_info=True)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.SIGNATURE_VERIFICATION_ERROR,
                boundary_stage=AuthorityBoundaryStage.ISSUER_AUTHORITY_CHECKS,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

    def _validate_action_and_resource_scope(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
    ) -> Optional[AuthorityDecision]:
        """Stage 4: action/resource authorization checks."""
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
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.ACTION_SCOPE_DENIED,
                boundary_stage=AuthorityBoundaryStage.ACTION_RESOURCE_AUTHORIZATION_CHECKS,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

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
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.RESOURCE_SCOPE_DENIED,
                boundary_stage=AuthorityBoundaryStage.ACTION_RESOURCE_AUTHORIZATION_CHECKS,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

        return None

    def _validate_caveat_chain_stage(
        self,
        *,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        caveat_chain: Optional[list[dict[str, Any]]],
        caveat_hmac_key: Optional[str],
        caveat_task_id: Optional[str],
        current_time: datetime,
    ) -> Optional[AuthorityDecision]:
        """Stage 3.5: optional caveat-chain boundary checks."""
        if caveat_chain is None:
            return None

        key = str(caveat_hmac_key or "").strip()
        if not key:
            reason = "Caveat chain validation key is missing"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.CAVEAT_CHAIN_DENIED,
                boundary_stage=AuthorityBoundaryStage.CAVEAT_CHAIN_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

        try:
            verified_chain = verify_caveat_chain(hmac_key=key, chain=caveat_chain)
            evaluate_caveat_chain(
                verified_chain=verified_chain,
                requested_action=requested_action,
                requested_resource=requested_resource,
                task_id=caveat_task_id,
                current_time=current_time,
            )
            return None
        except CaveatChainError as exc:
            reason = f"Caveat-chain validation denied request: {exc}"
            logger.warning(reason)
            return self._deny_decision(
                reason=reason,
                reason_code=AuthorityReasonCode.CAVEAT_CHAIN_DENIED,
                boundary_stage=AuthorityBoundaryStage.CAVEAT_CHAIN_VALIDATION,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
            )

    def _validate_delegation_path_stage(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
    ) -> Optional[AuthorityDecision]:
        """Stage 3: delegation path validation."""
        path_valid = self.check_delegation_path(mandate)
        if path_valid:
            return None

        reason = f"Delegation graph path is invalid for mandate {mandate.mandate_id}"
        logger.warning(reason)
        return self._deny_decision(
            reason=reason,
            reason_code=AuthorityReasonCode.DELEGATION_PATH_INVALID,
            boundary_stage=AuthorityBoundaryStage.DELEGATION_PATH_VALIDATION,
            mandate=mandate,
            requested_action=requested_action,
            requested_resource=requested_resource,
        )
    
    def validate_mandate(
        self,
        mandate: ExecutionMandate,
        requested_action: str,
        requested_resource: str,
        current_time: Optional[datetime] = None,
        caveat_chain: Optional[list[dict[str, Any]]] = None,
        caveat_hmac_key: Optional[str] = None,
        caveat_task_id: Optional[str] = None,
        caller_principal_id: Optional[str] = None,
    ) -> AuthorityDecision:
        """
        Validate a mandate for a specific action.

        Checks:
        - Cryptographic signature
        - Expiration
        - Revocation status
        - Action scope
        - Resource scope
        - Delegation path validity

        Returns AuthorityDecision with allow/deny and reason.
        Implements fail-closed semantics: any error results in denial.

        Args:
            mandate: The ExecutionMandate to validate
            requested_action: The action being requested
            requested_resource: The resource being accessed
            current_time: Optional current time (defaults to utcnow)

        Returns:
            AuthorityDecision with allow/deny and reason
        """
        self._active_caller_principal_id = caller_principal_id
        try:
            if current_time is None:
                current_time = datetime.utcnow()

            # Fail-closed: If mandate is None, deny
            if mandate is None:
                reason = "No mandate provided"
                logger.warning(reason)
                return self._deny_decision(
                    reason=reason,
                    reason_code=AuthorityReasonCode.MANDATE_MISSING,
                    boundary_stage=AuthorityBoundaryStage.MANDATE_STATE_VALIDATION,
                    mandate=None,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                    caller_principal_id=caller_principal_id,
                )

            logger.info(
                f"Validating mandate {mandate.mandate_id} for action={requested_action}, "
                f"resource={requested_resource}"
            )

            for check in (
                lambda m, a, r: self._validate_mandate_state(m, a, r, current_time),
                lambda m, a, r: self._validate_subject_binding_stage(
                    mandate=m,
                    requested_action=a,
                    requested_resource=r,
                    caller_principal_id=caller_principal_id,
                ),
                self._validate_issuer_authority,
                self._validate_delegation_path_stage,
                lambda m, a, r: self._validate_caveat_chain_stage(
                    mandate=m,
                    requested_action=a,
                    requested_resource=r,
                    caveat_chain=caveat_chain,
                    caveat_hmac_key=caveat_hmac_key,
                    caveat_task_id=caveat_task_id,
                    current_time=current_time,
                ),
                self._validate_action_and_resource_scope,
            ):
                decision = check(mandate, requested_action, requested_resource)
                if decision is not None:
                    return decision

            # All checks passed - allow the action
            reason = f"Mandate {mandate.mandate_id} is valid for action '{requested_action}' on resource '{requested_resource}'"
            logger.info(reason)
            return self._allow_decision(
                reason=reason,
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
                caller_principal_id=caller_principal_id,
            )
        finally:
            self._active_caller_principal_id = None
    
    def check_delegation_path(
        self,
        mandate: ExecutionMandate
    ) -> bool:
        """
        Validate delegation graph path for a mandate.

        Args:
            mandate: The mandate to validate against delegation graph topology

        Returns:
            True if delegation graph path is valid, False otherwise
        """
        logger.info(f"Checking delegation graph path for mandate {mandate.mandate_id}")

        from caracal.core.delegation_graph import DelegationGraph

        graph = self.delegation_graph or DelegationGraph(self.db_session)
        is_valid = graph.check_delegation_path(mandate.mandate_id)
        if is_valid:
            logger.info(f"Delegation graph path is valid for mandate {mandate.mandate_id}")
        return is_valid
