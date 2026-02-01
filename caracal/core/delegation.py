"""
Delegation token management for Caracal Core v0.2.

This module provides the DelegationTokenManager for generating and validating
ASE v1.0.8 delegation tokens using JWT with ECDSA P-256 signatures.

Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
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
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class DelegationTokenClaims:
    """
    Decoded claims from an ASE v1.0.8 delegation token.
    
    Attributes:
        issuer: Parent agent ID (UUID)
        subject: Child agent ID (UUID)
        audience: Target audience (e.g., "caracal-core")
        expiration: Token expiration timestamp
        issued_at: Token issuance timestamp
        token_id: Unique token identifier (jti claim)
        spending_limit: Maximum spending allowed
        currency: Currency code (e.g., "USD")
        allowed_operations: List of allowed operation types
        max_delegation_depth: Maximum delegation chain depth
        budget_category: Optional budget category
    """
    issuer: UUID
    subject: UUID
    audience: str
    expiration: datetime
    issued_at: datetime
    token_id: UUID
    spending_limit: Decimal
    currency: str
    allowed_operations: List[str]
    max_delegation_depth: int
    budget_category: Optional[str] = None


class DelegationTokenManager:
    """
    Manages ASE v1.0.8 delegation tokens for parent-child agent relationships.
    
    Generates JWT tokens signed with ECDSA P-256 (ES256) and validates
    token signatures, expiration, and spending limits.
    
    Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
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
            
        Requirements: 13.5
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
        parent_agent_id: UUID,
        child_agent_id: UUID,
        spending_limit: Decimal,
        currency: str = "USD",
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        max_delegation_depth: int = 2,
        budget_category: Optional[str] = None
    ) -> str:
        """
        Generate ASE v1.0.8 delegation token.
        
        Creates a JWT token signed with the parent agent's private key using
        ECDSA P-256 (ES256) algorithm per ASE v1.0.8 specification.
        
        Args:
            parent_agent_id: Parent agent ID (issuer)
            child_agent_id: Child agent ID (subject)
            spending_limit: Maximum spending allowed
            currency: Currency code (default: "USD")
            expiration_seconds: Token validity duration (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            max_delegation_depth: Maximum delegation chain depth (default: 2)
            budget_category: Optional budget category
            
        Returns:
            JWT token string
            
        Raises:
            AgentNotFoundError: If parent agent does not exist
            InvalidDelegationTokenError: If parent agent has no private key
            
        Requirements: 13.1, 13.2
        """
        # Get parent agent
        parent_agent = self.agent_registry.get_agent(str(parent_agent_id))
        if parent_agent is None:
            logger.error(f"Parent agent not found: {parent_agent_id}")
            raise AgentNotFoundError(
                f"Parent agent with ID '{parent_agent_id}' does not exist"
            )
        
        # Get parent agent's private key from metadata
        if parent_agent.metadata is None or "private_key_pem" not in parent_agent.metadata:
            logger.error(f"Parent agent {parent_agent_id} has no private key")
            raise InvalidDelegationTokenError(
                f"Parent agent '{parent_agent_id}' has no private key for signing"
            )
        
        private_key_pem = parent_agent.metadata["private_key_pem"]
        
        # Load private key
        try:
            private_key = serialization.load_pem_private_key(
                private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
                password=None,
                backend=default_backend()
            )
        except Exception as e:
            logger.error(f"Failed to load private key for agent {parent_agent_id}: {e}")
            raise InvalidDelegationTokenError(
                f"Failed to load private key for agent '{parent_agent_id}': {e}"
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
        
        # Build JWT payload per ASE v1.0.8 specification
        payload = {
            # Standard JWT claims
            "iss": str(parent_agent_id),
            "sub": str(child_agent_id),
            "aud": "caracal-core",
            "exp": int(expiration.timestamp()),
            "iat": int(now.timestamp()),
            "jti": token_id,
            
            # ASE v1.0.8 specific claims
            "spendingLimit": str(spending_limit),
            "currency": currency,
            "allowedOperations": allowed_operations,
            "maxDelegationDepth": max_delegation_depth,
        }
        
        # Add optional budget category
        if budget_category is not None:
            payload["budgetCategory"] = budget_category
        
        # Build JWT header
        headers = {
            "alg": "ES256",
            "typ": "JWT",
            "kid": str(parent_agent_id)
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
            f"Generated delegation token: parent={parent_agent_id}, child={child_agent_id}, "
            f"limit={spending_limit} {currency}, expires={expiration.isoformat()}"
        )
        
        return token

    def validate_token(self, token: str) -> DelegationTokenClaims:
        """
        Validate ASE v1.0.8 delegation token.
        
        Verifies:
        1. Token signature using parent agent's public key
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
            
        Requirements: 13.2, 13.3, 13.4
        """
        try:
            # Decode header without verification to get issuer (kid)
            unverified_header = jwt.get_unverified_header(token)
            issuer_id = unverified_header.get("kid")
            
            if issuer_id is None:
                logger.error("Token missing 'kid' header")
                raise TokenValidationError("Token missing 'kid' (issuer) header")
            
            # Get issuer agent
            issuer_agent = self.agent_registry.get_agent(issuer_id)
            if issuer_agent is None:
                logger.error(f"Issuer agent not found: {issuer_id}")
                raise AgentNotFoundError(
                    f"Issuer agent with ID '{issuer_id}' does not exist"
                )
            
            # Get issuer's public key from metadata
            if issuer_agent.metadata is None or "public_key_pem" not in issuer_agent.metadata:
                logger.error(f"Issuer agent {issuer_id} has no public key")
                raise TokenValidationError(
                    f"Issuer agent '{issuer_id}' has no public key for verification"
                )
            
            public_key_pem = issuer_agent.metadata["public_key_pem"]
            
            # Load public key
            try:
                public_key = serialization.load_pem_public_key(
                    public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem,
                    backend=default_backend()
                )
            except Exception as e:
                logger.error(f"Failed to load public key for agent {issuer_id}: {e}")
                raise TokenValidationError(
                    f"Failed to load public key for agent '{issuer_id}': {e}"
                ) from e
            
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
                logger.warning(f"Token expired: {e}")
                raise TokenExpiredError("Delegation token has expired") from e
            except jwt.InvalidTokenError as e:
                logger.error(f"Invalid token: {e}")
                raise TokenValidationError(f"Invalid delegation token: {e}") from e
            
            # Extract and validate required claims
            try:
                issuer = UUID(payload["iss"])
                subject = UUID(payload["sub"])
                audience = payload["aud"]
                expiration = datetime.fromtimestamp(payload["exp"])
                issued_at = datetime.fromtimestamp(payload["iat"])
                token_id = UUID(payload["jti"])
                spending_limit = Decimal(payload["spendingLimit"])
                currency = payload["currency"]
                allowed_operations = payload["allowedOperations"]
                max_delegation_depth = payload["maxDelegationDepth"]
                budget_category = payload.get("budgetCategory")
                
            except (KeyError, ValueError, TypeError) as e:
                logger.error(f"Token missing or invalid required claims: {e}")
                raise TokenValidationError(
                    f"Token missing or invalid required claims: {e}"
                ) from e
            
            # Create claims object
            claims = DelegationTokenClaims(
                issuer=issuer,
                subject=subject,
                audience=audience,
                expiration=expiration,
                issued_at=issued_at,
                token_id=token_id,
                spending_limit=spending_limit,
                currency=currency,
                allowed_operations=allowed_operations,
                max_delegation_depth=max_delegation_depth,
                budget_category=budget_category
            )
            
            logger.info(
                f"Validated delegation token: issuer={issuer}, subject={subject}, "
                f"limit={spending_limit} {currency}"
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

    def check_spending_limit(
        self,
        token_claims: DelegationTokenClaims,
        agent_id: UUID,
        current_spending: Decimal
    ) -> bool:
        """
        Check if agent is within delegation token spending limit.
        
        Args:
            token_claims: Validated delegation token claims
            agent_id: Agent ID to check (should match token subject)
            current_spending: Current spending amount
            
        Returns:
            True if within limit, False otherwise
            
        Requirements: 13.3, 13.4
        """
        # Verify agent matches token subject
        if agent_id != token_claims.subject:
            logger.warning(
                f"Agent ID mismatch: token subject={token_claims.subject}, "
                f"checking agent={agent_id}"
            )
            return False
        
        # Check spending limit
        within_limit = current_spending <= token_claims.spending_limit
        
        if within_limit:
            logger.debug(
                f"Agent {agent_id} within spending limit: "
                f"{current_spending} <= {token_claims.spending_limit} {token_claims.currency}"
            )
        else:
            logger.warning(
                f"Agent {agent_id} exceeded spending limit: "
                f"{current_spending} > {token_claims.spending_limit} {token_claims.currency}"
            )
        
        return within_limit
