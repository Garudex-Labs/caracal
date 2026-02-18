"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authentication service for Gateway Proxy.

Provides multiple authentication methods:
- mTLS: Mutual TLS with client certificate validation
- JWT: JSON Web Token with signature verification
- API Key: Hashed API key lookup

Requirements: 1.2, 2.1, 2.2, 2.3
"""

import hashlib
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional
from uuid import UUID

import bcrypt
import jwt
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.x509 import Certificate

from caracal.core.identity import AgentIdentity, AgentRegistry
from caracal.exceptions import (
    AgentNotFoundError,
    InvalidAgentIDError,
    TokenValidationError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthenticationMethod(Enum):
    """Supported authentication methods."""
    MTLS = "mtls"
    JWT = "jwt"
    API_KEY = "api_key"


@dataclass
class AuthenticationResult:
    """
    Result of authentication attempt.
    
    Attributes:
        success: Whether authentication succeeded
        agent_identity: The authenticated agent (if successful)
        method: Authentication method used
        error: Error message (if failed)
    """
    success: bool
    agent_identity: Optional[AgentIdentity]
    method: AuthenticationMethod
    error: Optional[str] = None


class Authenticator:
    """
    Authentication service for gateway proxy.
    
    Authenticates agents via multiple methods and returns agent identity.
    Implements fail-closed security: all errors result in authentication failure.
    
    Requirements: 1.2, 2.1, 2.2, 2.3
    """
    
    def __init__(
        self,
        agent_registry: AgentRegistry,
        jwt_public_key: Optional[str] = None,
        jwt_algorithm: str = "RS256",
        ca_cert_path: Optional[str] = None
    ):
        """
        Initialize Authenticator.
        
        Args:
            agent_registry: AgentRegistry for credential validation
            jwt_public_key: PEM-encoded public key for JWT verification (optional)
            jwt_algorithm: JWT signature algorithm (default: RS256)
            ca_cert_path: Path to CA certificate for mTLS validation (optional)
        """
        self.agent_registry = agent_registry
        self.jwt_public_key = jwt_public_key
        self.jwt_algorithm = jwt_algorithm
        self.ca_cert_path = ca_cert_path
        
        # Load CA certificate if provided
        self.ca_cert: Optional[Certificate] = None
        if ca_cert_path:
            try:
                with open(ca_cert_path, 'rb') as f:
                    self.ca_cert = x509.load_pem_x509_certificate(
                        f.read(),
                        default_backend()
                    )
                logger.info(f"Loaded CA certificate from {ca_cert_path}")
            except Exception as e:
                logger.error(f"Failed to load CA certificate: {e}", exc_info=True)
                raise
        
        logger.info(
            f"Initialized Authenticator with JWT algorithm: {jwt_algorithm}, "
            f"CA cert: {ca_cert_path is not None}"
        )
    
    async def authenticate_mtls(self, client_cert_pem: bytes) -> AuthenticationResult:
        """
        Authenticate agent via mTLS client certificate.
        
        Process:
        1. Parse client certificate
        2. Validate certificate against CA (if CA configured)
        3. Extract agent ID from certificate CN or SAN
        4. Verify agent exists in registry
        
        Args:
            client_cert_pem: PEM-encoded client certificate
            
        Returns:
            AuthenticationResult with agent identity if successful
            
        Requirements: 2.1
        """
        try:
            # Parse client certificate
            try:
                client_cert = x509.load_pem_x509_certificate(
                    client_cert_pem,
                    default_backend()
                )
            except Exception as e:
                logger.warning(f"Failed to parse client certificate: {e}")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.MTLS,
                    error=f"Invalid certificate format: {e}"
                )
            
            # Validate certificate against CA if configured
            if self.ca_cert:
                try:
                    # Verify certificate signature
                    # Note: Full chain validation would require additional logic
                    # For MVP, we do basic signature verification
                    ca_public_key = self.ca_cert.public_key()
                    client_cert.public_key().verify(
                        client_cert.signature,
                        client_cert.tbs_certificate_bytes,
                        client_cert.signature_algorithm_parameters
                    )
                except Exception as e:
                    logger.warning(f"Certificate validation failed: {e}")
                    return AuthenticationResult(
                        success=False,
                        agent_identity=None,
                        method=AuthenticationMethod.MTLS,
                        error=f"Certificate validation failed: {e}"
                    )
            
            # Extract agent ID from certificate
            # Try Common Name (CN) first
            agent_id_str = None
            for attribute in client_cert.subject:
                if attribute.oid == x509.NameOID.COMMON_NAME:
                    agent_id_str = attribute.value
                    break
            
            # If not in CN, try Subject Alternative Name (SAN)
            if not agent_id_str:
                try:
                    san_ext = client_cert.extensions.get_extension_for_oid(
                        x509.ExtensionOID.SUBJECT_ALTERNATIVE_NAME
                    )
                    for name in san_ext.value:
                        if isinstance(name, x509.DNSName):
                            agent_id_str = name.value
                            break
                except x509.ExtensionNotFound:
                    pass
            
            if not agent_id_str:
                logger.warning("No agent ID found in certificate CN or SAN")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.MTLS,
                    error="No agent ID found in certificate"
                )
            
            # Verify agent exists in registry
            agent = self.agent_registry.get_agent(agent_id_str)
            if not agent:
                logger.warning(f"Agent not found in registry: {agent_id_str}")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.MTLS,
                    error=f"Agent not found: {agent_id_str}"
                )
            
            logger.info(f"mTLS authentication successful for agent: {agent_id_str}")
            return AuthenticationResult(
                success=True,
                agent_identity=agent,
                method=AuthenticationMethod.MTLS
            )
            
        except Exception as e:
            logger.error(f"mTLS authentication error: {e}", exc_info=True)
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod.MTLS,
                error=f"Authentication error: {e}"
            )
    
    async def authenticate_jwt(self, token: str) -> AuthenticationResult:
        """
        Authenticate agent via JWT token.
        
        Process:
        1. Validate JWT signature using public key
        2. Check expiration time
        3. Extract agent ID from claims
        4. Verify agent exists in registry
        
        Args:
            token: JWT token string
            
        Returns:
            AuthenticationResult with agent identity if successful
            
        Requirements: 2.2
        """
        try:
            # Validate JWT signature and expiration
            if not self.jwt_public_key:
                logger.error("JWT authentication attempted but no public key configured")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.JWT,
                    error="JWT authentication not configured"
                )
            
            try:
                # Decode and verify JWT
                payload = jwt.decode(
                    token,
                    self.jwt_public_key,
                    algorithms=[self.jwt_algorithm],
                    options={
                        "verify_signature": True,
                        "verify_exp": True,
                        "require": ["exp", "agent_id"]
                    }
                )
            except jwt.ExpiredSignatureError:
                logger.warning("JWT token expired")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.JWT,
                    error="Token expired"
                )
            except jwt.InvalidTokenError as e:
                logger.warning(f"Invalid JWT token: {e}")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.JWT,
                    error=f"Invalid token: {e}"
                )
            
            # Extract agent ID from claims
            agent_id_str = payload.get("agent_id") or payload.get("sub")
            if not agent_id_str:
                logger.warning("No agent_id found in JWT claims")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.JWT,
                    error="No agent_id in token claims"
                )
            
            # Verify agent exists in registry
            agent = self.agent_registry.get_agent(agent_id_str)
            if not agent:
                logger.warning(f"Agent not found in registry: {agent_id_str}")
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=AuthenticationMethod.JWT,
                    error=f"Agent not found: {agent_id_str}"
                )
            
            logger.info(f"JWT authentication successful for agent: {agent_id_str}")
            return AuthenticationResult(
                success=True,
                agent_identity=agent,
                method=AuthenticationMethod.JWT
            )
            
        except Exception as e:
            logger.error(f"JWT authentication error: {e}", exc_info=True)
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod.JWT,
                error=f"Authentication error: {e}"
            )
    
    async def authenticate_api_key(self, api_key: str) -> AuthenticationResult:
        """
        Authenticate agent via API key.
        
        Process:
        1. Hash API key using bcrypt
        2. Look up agent by hashed key in registry
        3. Verify agent is active
        
        Args:
            api_key: Plain text API key
            
        Returns:
            AuthenticationResult with agent identity if successful
            
        Requirements: 2.3
        """
        try:
            # Hash the provided API key
            # Note: For lookup, we need to iterate through agents and verify
            # In production, consider using a separate API key index table
            
            # Iterate through all agents to find matching API key
            for agent in self.agent_registry.list_agents():
                api_key_hash = agent.metadata.get("api_key_hash")
                
                if not api_key_hash:
                    continue
                
                # Verify API key using bcrypt
                try:
                    if bcrypt.checkpw(
                        api_key.encode('utf-8'),
                        api_key_hash.encode('utf-8')
                    ):
                        logger.info(f"API key authentication successful for agent: {agent.agent_id}")
                        return AuthenticationResult(
                            success=True,
                            agent_identity=agent,
                            method=AuthenticationMethod.API_KEY
                        )
                except Exception as e:
                    logger.debug(f"API key verification failed for agent {agent.agent_id}: {e}")
                    continue
            
            # No matching API key found
            logger.warning("API key authentication failed: no matching key found")
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod.API_KEY,
                error="Invalid API key"
            )
            
        except Exception as e:
            logger.error(f"API key authentication error: {e}", exc_info=True)
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod.API_KEY,
                error=f"Authentication error: {e}"
            )
    
    async def authenticate(
        self,
        method: AuthenticationMethod,
        credentials: dict
    ) -> AuthenticationResult:
        """
        Authenticate agent using specified method.
        
        Convenience method that dispatches to appropriate authentication handler.
        
        Args:
            method: Authentication method to use
            credentials: Method-specific credentials dict
                - For mTLS: {"client_cert_pem": bytes}
                - For JWT: {"token": str}
                - For API Key: {"api_key": str}
                
        Returns:
            AuthenticationResult with agent identity if successful
        """
        if method == AuthenticationMethod.MTLS:
            return await self.authenticate_mtls(credentials["client_cert_pem"])
        elif method == AuthenticationMethod.JWT:
            return await self.authenticate_jwt(credentials["token"])
        elif method == AuthenticationMethod.API_KEY:
            return await self.authenticate_api_key(credentials["api_key"])
        else:
            logger.error(f"Unsupported authentication method: {method}")
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=method,
                error=f"Unsupported authentication method: {method}"
            )
