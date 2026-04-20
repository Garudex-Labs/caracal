"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Delegation token management for Caracal Core.

This module provides the DelegationTokenManager for generating and validating
delegation tokens using JWT with ECDSA P-256 signatures. Supports graph-based
authority delegation across principal types (human, orchestrator, worker, service).

"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional
from uuid import UUID

import jwt

from caracal.exceptions import (
    PrincipalNotFoundError,
    InvalidDelegationTokenError,
    TokenExpiredError,
    TokenValidationError,
)
from caracal.core.signing_service import (
    SigningService,
    SigningServiceError,
    SigningServiceExpiredToken,
    SigningServiceInvalidToken,
    SigningServiceKeyError,
)
from caracal.core.error_handling import (
    get_error_handler,
    ErrorCategory,
    ErrorSeverity
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)

# Delegation token configuration constants (moved from ASEConfig)
DEFAULT_DELEGATION_TOKEN_EXPIRATION_SECONDS = 86400  # 24 hours
DEFAULT_KEY_ALGORITHM = "RS256"  # RS256 or ES256


@dataclass
class DelegationTokenClaims:
    """
    Decoded claims from a delegation token.
    
    Attributes:
        issuer: Source principal ID (UUID)
        subject: Target principal ID (UUID)
        audience: Target audience (e.g., "caracal-core")
        expiration: Token expiration timestamp
        issued_at: Token issuance timestamp
        token_id: Unique token identifier (jti claim)
        allowed_operations: List of allowed operation types
        delegation_type: Type of delegation (directed/peer)
        source_principal_kind: Type of the delegating principal
        target_principal_kind: Type of the receiving principal
        context_tags: Context tags for dynamic authority filtering
        source_mandate_id: Canonical source mandate lineage ID
    """
    issuer: UUID
    subject: UUID
    audience: str
    expiration: datetime
    issued_at: datetime
    token_id: UUID
    allowed_operations: List[str]
    delegation_type: str = "directed"
    source_principal_kind: str = "worker"
    target_principal_kind: str = "worker"
    context_tags: Optional[List[str]] = None
    source_mandate_id: Optional[UUID] = None


class DelegationTokenManager:
    """
    Manages delegation tokens for graph-based authority delegation.
    
    Generates JWT tokens signed with ECDSA P-256 (ES256) and validates
    token signatures, expiration, and authority limits.
    Supports delegation across principal types (human, orchestrator, worker, service).
    
    """

    def __init__(self, principal_registry, signing_service: Optional[SigningService] = None):
        """
        Initialize DelegationTokenManager.
        
        Args:
            principal_registry: PrincipalRegistry instance for key management
        """
        self.principal_registry = principal_registry
        self._signing_service = signing_service or SigningService(principal_registry)
        logger.info("DelegationTokenManager initialized")

    def generate_token(
        self,
        source_principal_id: UUID,
        target_principal_id: UUID,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        delegation_type: str = "directed",
        source_principal_kind: str = "worker",
        target_principal_kind: str = "worker",
        context_tags: Optional[List[str]] = None,
        source_mandate_id: Optional[UUID] = None,
    ) -> str:
        """
        Generate delegation token.
        
        Creates a JWT token signed with the source principal's private key using
        ECDSA P-256 (ES256) algorithm.
        
        Args:
            source_principal_id: Source principal ID (issuer/delegator)
            target_principal_id: Target principal ID (subject/delegate)
            expiration_seconds: Token validity duration (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            delegation_type: Type of delegation (directed/peer)
            source_principal_kind: Type of delegating principal
            target_principal_kind: Type of receiving principal
            context_tags: Context tags for dynamic authority filtering
            source_mandate_id: Canonical source mandate lineage ID
            
        Returns:
            JWT token string
            
        Raises:
            PrincipalNotFoundError: If source principal does not exist
            InvalidDelegationTokenError: If source principal has no private key
            
        """
        # Get source principal
        source_principal = self.principal_registry.get_principal(str(source_principal_id))
        if source_principal is None:
            logger.error(f"Source principal not found: {source_principal_id}")
            raise PrincipalNotFoundError(
                f"Source principal with ID '{source_principal_id}' does not exist"
            )
        
        # Set default allowed operations
        if allowed_operations is None:
            allowed_operations = ["api_call", "mcp_tool"]
        
        # Calculate timestamps
        now = datetime.now(timezone.utc)
        expiration = now + timedelta(seconds=expiration_seconds)
        
        # Generate unique token ID
        import uuid
        token_id = str(uuid.uuid4())
        
        # Build JWT payload
        payload = {
            # Standard JWT claims
            "iss": str(source_principal_id),
            "sub": str(target_principal_id),
            "aud": "caracal-core",
            "exp": int(expiration.timestamp()),
            "iat": int(now.timestamp()),
            "jti": token_id,
            
            # Delegation claims
            "allowedOperations": allowed_operations,
            "delegationType": delegation_type,
            "sourcePrincipalKind": source_principal_kind,
            "targetPrincipalKind": target_principal_kind,
        }
        
        # Optional claims
        if context_tags:
            payload["contextTags"] = context_tags
        if source_mandate_id:
            payload["sourceMandateId"] = str(source_mandate_id)
        
        # Build JWT header
        headers = {
            "alg": "ES256",
            "typ": "JWT",
            "kid": str(source_principal_id)
        }
        
        # Sign token through signing service abstraction.
        try:
            token = self._signing_service.sign_jwt_for_principal(
                principal_id=str(source_principal_id),
                payload=payload,
                headers=headers,
                algorithm="ES256",
            )
        except SigningServiceError as e:
            logger.error(f"Failed to sign delegation token: {e}")
            raise InvalidDelegationTokenError(
                f"Failed to sign delegation token: {e}"
            ) from e
        
        logger.info(
            f"Generated delegation token: source={source_principal_id}, target={target_principal_id}, "
            f"type={delegation_type}, {source_principal_kind}→{target_principal_kind}, "
            f"expires={expiration.isoformat()}"
        )
        
        return token

    def validate_token(self, token: str) -> DelegationTokenClaims:
        """        
        Verifies:
        1. Token signature using source principal's public key
        2. Token expiration
        3. Required claims presence
        
        Args:
            token: JWT token string
            
        Returns:
            DelegationTokenClaims with decoded and validated claims
            
        Raises:
            TokenValidationError: If token is invalid or signature verification fails
            TokenExpiredError: If token has expired
            PrincipalNotFoundError: If issuer principal does not exist
            
        """
        try:
            # Decode header without verification to get issuer (kid)
            unverified_header = jwt.get_unverified_header(token)
            issuer_id = unverified_header.get("kid")
            
            if issuer_id is None:
                # Fail closed: deny if issuer cannot be determined (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError("Token missing 'kid' (issuer) header")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    metadata={"token_header": unverified_header},
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error("Token missing 'kid' header (fail-closed)")
                raise error
            
            # Get issuer principal
            issuer_principal = self.principal_registry.get_principal(issuer_id)
            if issuer_principal is None:
                # Fail closed: deny if issuer principal doesn't exist (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = PrincipalNotFoundError(f"Issuer principal with ID '{issuer_id}' does not exist")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    metadata={"issuer_id": issuer_id},
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Issuer principal not found (fail-closed): {issuer_id}")
                raise error
            
            # Verify and decode token through signing service abstraction.
            try:
                payload = self._signing_service.verify_jwt_for_principal(
                    token=token,
                    principal_id=issuer_id,
                    audience="caracal-core",
                    algorithms=["ES256"],
                )
            except (SigningServiceExpiredToken, jwt.ExpiredSignatureError) as e:
                # Token expired - log and deny (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenExpiredError("Delegation token has expired")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    principal_id=issuer_id,
                    severity=ErrorSeverity.HIGH
                )
                logger.warning(f"Token expired (fail-closed): {e}")
                raise error from e
            except SigningServiceKeyError as e:
                # Fail closed: deny if public key cannot be resolved/loaded
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Failed to resolve verification key for principal '{issuer_id}': {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    principal_id=issuer_id,
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Verification key resolution failed for principal {issuer_id} (fail-closed): {e}")
                raise error from e
            except (SigningServiceInvalidToken, jwt.InvalidTokenError) as e:
                # Invalid token - log and deny (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Invalid delegation token: {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    principal_id=issuer_id,
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Invalid token (fail-closed): {e}")
                raise error from e
            
            # Extract and validate required claims
            try:
                issuer = UUID(payload["iss"])
                subject = UUID(payload["sub"])
                audience = payload["aud"]
                expiration = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
                issued_at = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
                token_id = UUID(payload["jti"])
                allowed_operations = payload["allowedOperations"]
                delegation_type = payload.get("delegationType", "directed")
                source_principal_kind = payload.get("sourcePrincipalKind", "worker")
                target_principal_kind = payload.get("targetPrincipalKind", "worker")
                context_tags = payload.get("contextTags")
                source_mandate_claim = payload.get("sourceMandateId")
                source_mandate_id = UUID(source_mandate_claim) if source_mandate_claim else None
                
            except (KeyError, ValueError, TypeError) as e:
                # Missing or invalid claims - fail closed (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Token missing or invalid required claims: {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    principal_id=issuer_id,
                    metadata={"payload_keys": list(payload.keys())},
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Token missing or invalid required claims (fail-closed): {e}")
                raise error from e
            
            # Create claims object
            claims = DelegationTokenClaims(
                issuer=issuer,
                subject=subject,
                audience=audience,
                expiration=expiration,
                issued_at=issued_at,
                token_id=token_id,
                allowed_operations=allowed_operations,
                delegation_type=delegation_type,
                source_principal_kind=source_principal_kind,
                target_principal_kind=target_principal_kind,
                context_tags=context_tags,
                source_mandate_id=source_mandate_id,
            )
            
            logger.info(
                f"Validated delegation token: issuer={issuer}, subject={subject}, "
                f"type={delegation_type}"
            )
            
            return claims
            
        except (TokenValidationError, TokenExpiredError, PrincipalNotFoundError):
            # Re-raise known exceptions
            raise
        except Exception as e:
            logger.error(f"Unexpected error validating token: {e}", exc_info=True)
            raise TokenValidationError(
                f"Unexpected error validating token: {e}"
            ) from e
