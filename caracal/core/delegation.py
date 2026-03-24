"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Delegation token management for Caracal Core.

This module provides the DelegationTokenManager for generating and validating
delegation tokens using JWT with ECDSA P-256 signatures. Supports graph-based
authority delegation across principal types (user, agent, service).

"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, List, Optional
from uuid import UUID

import jwt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from caracal.exceptions import (
    AgentNotFoundError,
    InvalidDelegationTokenError,
    TokenExpiredError,
    TokenValidationError,
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
        delegation_type: Type of delegation (hierarchical/peer)
        source_principal_type: Type of the delegating principal (user/agent/service)
        target_principal_type: Type of the receiving principal (user/agent/service)
        context_tags: Context tags for dynamic authority filtering
        authority_sources: List of source mandate IDs (for multi-source)
    """
    issuer: UUID
    subject: UUID
    audience: str
    expiration: datetime
    issued_at: datetime
    token_id: UUID
    allowed_operations: List[str]
    delegation_type: str = "hierarchical"
    source_principal_type: str = "agent"
    target_principal_type: str = "agent"
    context_tags: Optional[List[str]] = None
    authority_sources: Optional[List[str]] = None


class DelegationTokenManager:
    """
    Manages delegation tokens for graph-based authority delegation.
    
    Generates JWT tokens signed with ECDSA P-256 (ES256) and validates
    token signatures, expiration, and authority limits.
    Supports delegation across principal types (user, agent, service).
    
    """

    def __init__(self, agent_registry):
        """
        Initialize DelegationTokenManager.
        
        Args:
            agent_registry: AgentRegistry instance for key management
        """
        self.agent_registry = agent_registry
        logger.info("DelegationTokenManager initialized")

    def generate_key_pair(self) -> tuple[bytes, bytes]:
        """
        Generate ECDSA P-256 key pair for an agent.
        
        Returns:
            Tuple of (private_key_pem, public_key_pem) as bytes
            
        """
        # Generate ECDSA P-256 private key
        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        
        # Serialize private key to PEM format
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )
        
        # Extract public key and serialize to PEM format
        public_key = private_key.public_key()
        public_key_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        
        logger.debug("Generated ECDSA P-256 key pair")
        
        return private_key_pem, public_key_pem

    def generate_token(
        self,
        source_agent_id: UUID,
        target_agent_id: UUID,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        delegation_type: str = "hierarchical",
        source_principal_type: str = "agent",
        target_principal_type: str = "agent",
        context_tags: Optional[List[str]] = None,
        authority_sources: Optional[List[str]] = None,
    ) -> str:
        """
        Generate delegation token.
        
        Creates a JWT token signed with the source principal's private key using
        ECDSA P-256 (ES256) algorithm.
        
        Args:
            source_agent_id: Source principal ID (issuer/delegator)
            target_agent_id: Target principal ID (subject/delegate)
            expiration_seconds: Token validity duration (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            delegation_type: Type of delegation (hierarchical/peer)
            source_principal_type: Type of delegating principal (user/agent/service)
            target_principal_type: Type of receiving principal (user/agent/service)
            context_tags: Context tags for dynamic authority filtering
            authority_sources: List of source mandate IDs for multi-source
            
        Returns:
            JWT token string
            
        Raises:
            AgentNotFoundError: If source principal does not exist
            InvalidDelegationTokenError: If source principal has no private key
            
        """
        # Get source agent
        source_agent = self.agent_registry.get_agent(str(source_agent_id))
        if source_agent is None:
            logger.error(f"Source principal not found: {source_agent_id}")
            raise AgentNotFoundError(
                f"Source principal with ID '{source_agent_id}' does not exist"
            )
        
        # Get source agent's private key from metadata
        if source_agent.metadata is None or "private_key_pem" not in source_agent.metadata:
            logger.error(f"Source principal {source_agent_id} has no private key")
            raise InvalidDelegationTokenError(
                f"Source principal '{source_agent_id}' has no private key for signing"
            )
        
        private_key_pem = source_agent.metadata["private_key_pem"]
        
        # Load private key
        try:
            private_key = serialization.load_pem_private_key(
                private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
                password=None,
                backend=default_backend()
            )
        except Exception as e:
            logger.error(f"Failed to load private key for principal {source_agent_id}: {e}")
            raise InvalidDelegationTokenError(
                f"Failed to load private key for principal '{source_agent_id}': {e}"
            ) from e
        
        # Set default allowed operations
        if allowed_operations is None:
            allowed_operations = ["api_call", "mcp_tool"]
        
        # Calculate timestamps
        now = datetime.utcnow()
        expiration = now + timedelta(seconds=expiration_seconds)
        
        # Generate unique token ID
        import uuid
        token_id = str(uuid.uuid4())
        
        # Build JWT payload
        payload = {
            # Standard JWT claims
            "iss": str(source_agent_id),
            "sub": str(target_agent_id),
            "aud": "caracal-core",
            "exp": int(expiration.timestamp()),
            "iat": int(now.timestamp()),
            "jti": token_id,
            
            # Delegation claims
            "allowedOperations": allowed_operations,
            "delegationType": delegation_type,
            "sourcePrincipalType": source_principal_type,
            "targetPrincipalType": target_principal_type,
        }
        
        # Optional claims
        if context_tags:
            payload["contextTags"] = context_tags
        if authority_sources:
            payload["authoritySources"] = authority_sources
        
        # Build JWT header
        headers = {
            "alg": "ES256",
            "typ": "JWT",
            "kid": str(source_agent_id)
        }
        
        # Sign token with ES256 (ECDSA P-256)
        try:
            token = jwt.encode(
                payload,
                private_key,
                algorithm="ES256",
                headers=headers
            )
        except Exception as e:
            logger.error(f"Failed to sign delegation token: {e}")
            raise InvalidDelegationTokenError(
                f"Failed to sign delegation token: {e}"
            ) from e
        
        logger.info(
            f"Generated delegation token: source={parent_agent_id}, target={child_agent_id}, "
            f"type={delegation_type}, {source_principal_type}→{target_principal_type}, "
            f"expires={expiration.isoformat()}"
        )
        
        return token

    def validate_token(self, token: str) -> DelegationTokenClaims:
        """
        Validate ASE v1.0.8 delegation token.
        
        Verifies:
        1. Token signature using source agent's public key
        2. Token expiration
        3. Required claims presence
        
        Args:
            token: JWT token string
            
        Returns:
            DelegationTokenClaims with decoded and validated claims
            
        Raises:
            TokenValidationError: If token is invalid or signature verification fails
            TokenExpiredError: If token has expired
            AgentNotFoundError: If issuer agent does not exist
            
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
            
            # Get issuer agent
            issuer_agent = self.agent_registry.get_agent(issuer_id)
            if issuer_agent is None:
                # Fail closed: deny if issuer agent doesn't exist (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = AgentNotFoundError(f"Issuer agent with ID '{issuer_id}' does not exist")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    metadata={"issuer_id": issuer_id},
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Issuer agent not found (fail-closed): {issuer_id}")
                raise error
            
            # Get issuer's public key from metadata
            if issuer_agent.metadata is None or "public_key_pem" not in issuer_agent.metadata:
                # Fail closed: deny if public key not available (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Issuer agent '{issuer_id}' has no public key for verification")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    agent_id=issuer_id,
                    metadata={"has_metadata": issuer_agent.metadata is not None},
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Issuer agent {issuer_id} has no public key (fail-closed)")
                raise error
            
            public_key_pem = issuer_agent.metadata["public_key_pem"]
            
            # Load public key
            try:
                public_key = serialization.load_pem_public_key(
                    public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem,
                    backend=default_backend()
                )
            except Exception as e:
                # Fail closed: deny if public key cannot be loaded (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Failed to load public key for agent '{issuer_id}': {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    agent_id=issuer_id,
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Failed to load public key for agent {issuer_id} (fail-closed): {e}")
                raise error from e
            
            # Verify and decode token
            try:
                payload = jwt.decode(
                    token,
                    public_key,
                    algorithms=["ES256"],
                    audience="caracal-core",
                    options={"verify_exp": True}
                )
            except jwt.ExpiredSignatureError as e:
                # Token expired - log and deny (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenExpiredError("Delegation token has expired")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    agent_id=issuer_id,
                    severity=ErrorSeverity.HIGH
                )
                logger.warning(f"Token expired (fail-closed): {e}")
                raise error from e
            except jwt.InvalidTokenError as e:
                # Invalid token - log and deny (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Invalid delegation token: {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    agent_id=issuer_id,
                    severity=ErrorSeverity.CRITICAL
                )
                logger.error(f"Invalid token (fail-closed): {e}")
                raise error from e
            
            # Extract and validate required claims
            try:
                issuer = UUID(payload["iss"])
                subject = UUID(payload["sub"])
                audience = payload["aud"]
                expiration = datetime.fromtimestamp(payload["exp"])
                issued_at = datetime.fromtimestamp(payload["iat"])
                token_id = UUID(payload["jti"])
                allowed_operations = payload["allowedOperations"]
                delegation_type = payload.get("delegationType", "hierarchical")
                source_principal_type = payload.get("sourcePrincipalType", "agent")
                target_principal_type = payload.get("targetPrincipalType", "agent")
                context_tags = payload.get("contextTags")
                authority_sources = payload.get("authoritySources")
                
            except (KeyError, ValueError, TypeError) as e:
                # Missing or invalid claims - fail closed (Requirement 23.3)
                error_handler = get_error_handler("delegation-token-manager")
                error = TokenValidationError(f"Token missing or invalid required claims: {e}")
                error_handler.handle_error(
                    error=error,
                    category=ErrorCategory.DELEGATION,
                    operation="validate_token",
                    agent_id=issuer_id,
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
                source_principal_type=source_principal_type,
                target_principal_type=target_principal_type,
                context_tags=context_tags,
                authority_sources=authority_sources,
            )
            
            logger.info(
                f"Validated delegation token: issuer={issuer}, subject={subject}, "
                f"type={delegation_type}"
            )
            
            return claims
            
        except (TokenValidationError, TokenExpiredError, AgentNotFoundError):
            # Re-raise known exceptions
            raise
        except Exception as e:
            logger.error(f"Unexpected error validating token: {e}", exc_info=True)
            raise TokenValidationError(
                f"Unexpected error validating token: {e}"
            ) from e
