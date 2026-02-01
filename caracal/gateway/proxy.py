"""
Gateway Proxy server for Caracal Core v0.2.

Provides network-enforced policy enforcement through:
- HTTP/gRPC reverse proxy for intercepting API calls
- Authentication integration (mTLS, JWT, API keys)
- Policy evaluation before forwarding requests
- Replay protection
- Request forwarding to target APIs
- Final charge emission after responses

Requirements: 1.1, 1.2, 1.6
"""

import asyncio
import logging
import ssl
import time
from dataclasses import dataclass
from typing import Optional, Dict, Any
from uuid import UUID

import httpx
from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse

from caracal.gateway.auth import Authenticator, AuthenticationMethod, AuthenticationResult
from caracal.gateway.replay_protection import ReplayProtection, ReplayCheckResult
from caracal.core.policy import PolicyEvaluator, PolicyDecision
from caracal.core.metering import MeteringCollector
from caracal.exceptions import (
    BudgetExceededError,
    PolicyEvaluationError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class GatewayConfig:
    """
    Configuration for Gateway Proxy.
    
    Attributes:
        listen_address: Address to bind the server (e.g., "0.0.0.0:8443")
        tls_cert_file: Path to TLS certificate file
        tls_key_file: Path to TLS private key file
        tls_ca_file: Optional path to CA certificate for mTLS
        auth_mode: Authentication mode ("mtls", "jwt", or "api_key")
        jwt_public_key: Optional PEM-encoded public key for JWT verification
        jwt_algorithm: JWT signature algorithm (default: "RS256")
        enable_replay_protection: Enable replay protection (default: True)
        nonce_cache_ttl: TTL for nonce cache in seconds (default: 300)
        nonce_cache_size: Maximum nonce cache size (default: 100000)
        timestamp_window_seconds: Maximum timestamp age in seconds (default: 300)
        request_timeout_seconds: Timeout for forwarded requests (default: 30)
        max_request_size_mb: Maximum request body size in MB (default: 10)
    """
    listen_address: str = "0.0.0.0:8443"
    tls_cert_file: Optional[str] = None
    tls_key_file: Optional[str] = None
    tls_ca_file: Optional[str] = None
    auth_mode: str = "jwt"
    jwt_public_key: Optional[str] = None
    jwt_algorithm: str = "RS256"
    enable_replay_protection: bool = True
    nonce_cache_ttl: int = 300
    nonce_cache_size: int = 100000
    timestamp_window_seconds: int = 300
    request_timeout_seconds: int = 30
    max_request_size_mb: int = 10


class GatewayProxy:
    """
    Gateway Proxy server for network-enforced policy enforcement.
    
    Intercepts outbound API calls from agents and enforces budget policies
    at the network layer. Provides authentication, policy evaluation,
    request forwarding, and metering.
    
    Requirements: 1.1, 1.2, 1.6
    """
    
    def __init__(
        self,
        config: GatewayConfig,
        authenticator: Authenticator,
        policy_evaluator: PolicyEvaluator,
        metering_collector: MeteringCollector,
        replay_protection: Optional[ReplayProtection] = None
    ):
        """
        Initialize Gateway Proxy.
        
        Args:
            config: GatewayConfig with server settings
            authenticator: Authenticator for agent authentication
            policy_evaluator: PolicyEvaluator for budget checks
            metering_collector: MeteringCollector for final charges
            replay_protection: Optional ReplayProtection for replay attack prevention
        """
        self.config = config
        self.authenticator = authenticator
        self.policy_evaluator = policy_evaluator
        self.metering_collector = metering_collector
        self.replay_protection = replay_protection
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Caracal Gateway Proxy",
            description="Network-enforced policy enforcement for AI agents",
            version="0.2.0"
        )
        
        # Register routes
        self._register_routes()
        
        # HTTP client for forwarding requests
        self.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.config.request_timeout_seconds),
            follow_redirects=True
        )
        
        # Statistics
        self._request_count = 0
        self._allowed_count = 0
        self._denied_count = 0
        self._auth_failures = 0
        self._replay_blocks = 0
        
        logger.info(
            f"Initialized GatewayProxy with auth_mode={config.auth_mode}, "
            f"replay_protection={replay_protection is not None}"
        )
    
    def _register_routes(self):
        """Register FastAPI routes."""
        
        @self.app.get("/health")
        async def health_check():
            """Health check endpoint for liveness/readiness probes."""
            return {
                "status": "healthy",
                "service": "caracal-gateway-proxy",
                "version": "0.2.0"
            }
        
        @self.app.get("/stats")
        async def get_stats():
            """Get gateway statistics."""
            stats = {
                "requests_total": self._request_count,
                "requests_allowed": self._allowed_count,
                "requests_denied": self._denied_count,
                "auth_failures": self._auth_failures,
                "replay_blocks": self._replay_blocks,
            }
            
            # Add replay protection stats if available
            if self.replay_protection:
                stats["replay_protection"] = self.replay_protection.get_stats()
            
            return stats
        
        @self.app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
        async def handle_request(request: Request, path: str):
            """
            Main request handler for all proxied requests.
            
            Process:
            1. Authenticate agent
            2. Check replay protection
            3. Evaluate budget policy
            4. Forward request to target API
            5. Emit final charge
            6. Return response
            """
            return await self._handle_request(request, path)
    
    async def _handle_request(self, request: Request, path: str) -> Response:
        """
        Handle incoming request with authentication, policy check, and forwarding.
        
        Args:
            request: FastAPI Request object
            path: Request path
            
        Returns:
            Response from target API or error response
        """
        start_time = time.time()
        self._request_count += 1
        
        try:
            # 1. Authenticate agent
            auth_result = await self.authenticate_agent(request)
            
            if not auth_result.success:
                self._auth_failures += 1
                logger.warning(
                    f"Authentication failed: {auth_result.error}, "
                    f"method={auth_result.method}"
                )
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={
                        "error": "authentication_failed",
                        "message": auth_result.error,
                        "method": auth_result.method.value
                    }
                )
            
            agent = auth_result.agent_identity
            logger.info(
                f"Authenticated agent: {agent.agent_id} ({agent.name}), "
                f"method={auth_result.method.value}"
            )
            
            # 2. Check replay protection
            if self.replay_protection and self.config.enable_replay_protection:
                replay_result = await self.check_replay(request)
                
                if not replay_result.allowed:
                    self._replay_blocks += 1
                    logger.warning(
                        f"Replay attack blocked for agent {agent.agent_id}: {replay_result.reason}"
                    )
                    return JSONResponse(
                        status_code=status.HTTP_403_FORBIDDEN,
                        content={
                            "error": "replay_detected",
                            "message": replay_result.reason
                        }
                    )
            
            # 3. Evaluate budget policy
            # Extract estimated cost from request headers (optional)
            estimated_cost_str = request.headers.get("X-Caracal-Estimated-Cost")
            estimated_cost = None
            if estimated_cost_str:
                try:
                    from decimal import Decimal
                    estimated_cost = Decimal(estimated_cost_str)
                except Exception as e:
                    logger.warning(f"Invalid estimated cost header: {estimated_cost_str}, error: {e}")
            
            # Call PolicyEvaluator to check budget
            try:
                policy_decision = self.policy_evaluator.check_budget(
                    agent_id=str(agent.agent_id),
                    estimated_cost=estimated_cost
                )
            except PolicyEvaluationError as e:
                logger.error(f"Policy evaluation failed for agent {agent.agent_id}: {e}")
                return JSONResponse(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    content={
                        "error": "policy_evaluation_failed",
                        "message": str(e)
                    }
                )
            
            # Return 403 on budget denial (Requirement 1.5)
            if not policy_decision.allowed:
                self._denied_count += 1
                logger.info(
                    f"Budget check denied for agent {agent.agent_id}: {policy_decision.reason}"
                )
                return JSONResponse(
                    status_code=status.HTTP_403_FORBIDDEN,
                    content={
                        "error": "budget_exceeded",
                        "message": policy_decision.reason,
                        "remaining_budget": str(policy_decision.remaining_budget) if policy_decision.remaining_budget else None
                    }
                )
            
            # Budget check passed - provisional charge created if manager available (Requirement 1.3, 1.4)
            logger.info(
                f"Budget check allowed for agent {agent.agent_id}, "
                f"remaining={policy_decision.remaining_budget}, "
                f"provisional_charge_id={policy_decision.provisional_charge_id}"
            )
            
            # 4. Forward request to target API
            target_url = request.headers.get("X-Caracal-Target-URL")
            if not target_url:
                logger.warning(f"Missing X-Caracal-Target-URL header for agent {agent.agent_id}")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={
                        "error": "missing_target_url",
                        "message": "X-Caracal-Target-URL header is required"
                    }
                )
            
            try:
                response = await self.forward_request(request, target_url)
            except Exception as e:
                logger.error(f"Failed to forward request for agent {agent.agent_id}: {e}", exc_info=True)
                return JSONResponse(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    content={
                        "error": "request_forwarding_failed",
                        "message": str(e)
                    }
                )
            
            # 5. Emit final charge (metering event)
            # Extract actual cost from response headers (optional)
            actual_cost_str = response.headers.get("X-Caracal-Actual-Cost")
            if actual_cost_str:
                try:
                    from decimal import Decimal
                    from ase.protocol import MeteringEvent
                    from datetime import datetime
                    
                    actual_cost = Decimal(actual_cost_str)
                    
                    # Create metering event
                    metering_event = MeteringEvent(
                        agent_id=agent.agent_id,
                        resource_type=request.headers.get("X-Caracal-Resource-Type", "api_call"),
                        quantity=Decimal("1"),
                        timestamp=datetime.utcnow(),
                        metadata={
                            "method": request.method,
                            "path": path,
                            "target_url": target_url,
                            "status_code": response.status_code
                        }
                    )
                    
                    # Collect event with provisional charge ID
                    self.metering_collector.collect_event(
                        metering_event,
                        provisional_charge_id=policy_decision.provisional_charge_id
                    )
                    
                    logger.info(
                        f"Emitted final charge for agent {agent.agent_id}, "
                        f"cost={actual_cost}, provisional_charge_id={policy_decision.provisional_charge_id}"
                    )
                except Exception as e:
                    logger.error(f"Failed to emit final charge for agent {agent.agent_id}: {e}", exc_info=True)
                    # Don't fail the request if metering fails
            
            # 6. Return response
            self._allowed_count += 1
            duration_ms = (time.time() - start_time) * 1000
            logger.info(
                f"Request completed for agent {agent.agent_id}, "
                f"status={response.status_code}, duration={duration_ms:.2f}ms"
            )
            
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.headers.get("content-type")
            )
            
        except Exception as e:
            logger.error(f"Unexpected error handling request: {e}", exc_info=True)
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={
                    "error": "internal_server_error",
                    "message": "An unexpected error occurred"
                }
            )
    
    async def authenticate_agent(self, request: Request) -> AuthenticationResult:
        """
        Authenticate agent from request.
        
        Extracts authentication credentials based on configured auth_mode:
        - mTLS: Extract client certificate from TLS connection
        - JWT: Extract Bearer token from Authorization header
        - API Key: Extract API key from X-API-Key header
        
        Args:
            request: FastAPI Request object
            
        Returns:
            AuthenticationResult with agent identity if successful
        """
        try:
            auth_mode = AuthenticationMethod(self.config.auth_mode)
            
            if auth_mode == AuthenticationMethod.MTLS:
                # Extract client certificate from TLS connection
                # Note: FastAPI/Starlette doesn't directly expose client cert
                # This would need to be implemented at the ASGI server level (uvicorn)
                # For now, we'll check for a header that the TLS terminator might set
                client_cert_pem = request.headers.get("X-Client-Cert")
                
                if not client_cert_pem:
                    return AuthenticationResult(
                        success=False,
                        agent_identity=None,
                        method=AuthenticationMethod.MTLS,
                        error="No client certificate provided"
                    )
                
                # Decode URL-encoded certificate
                import urllib.parse
                client_cert_pem = urllib.parse.unquote(client_cert_pem)
                
                return await self.authenticator.authenticate_mtls(
                    client_cert_pem.encode('utf-8')
                )
            
            elif auth_mode == AuthenticationMethod.JWT:
                # Extract Bearer token from Authorization header
                auth_header = request.headers.get("Authorization")
                
                if not auth_header:
                    return AuthenticationResult(
                        success=False,
                        agent_identity=None,
                        method=AuthenticationMethod.JWT,
                        error="No Authorization header provided"
                    )
                
                # Parse "Bearer <token>"
                parts = auth_header.split()
                if len(parts) != 2 or parts[0].lower() != "bearer":
                    return AuthenticationResult(
                        success=False,
                        agent_identity=None,
                        method=AuthenticationMethod.JWT,
                        error="Invalid Authorization header format (expected 'Bearer <token>')"
                    )
                
                token = parts[1]
                return await self.authenticator.authenticate_jwt(token)
            
            elif auth_mode == AuthenticationMethod.API_KEY:
                # Extract API key from X-API-Key header
                api_key = request.headers.get("X-API-Key")
                
                if not api_key:
                    return AuthenticationResult(
                        success=False,
                        agent_identity=None,
                        method=AuthenticationMethod.API_KEY,
                        error="No X-API-Key header provided"
                    )
                
                return await self.authenticator.authenticate_api_key(api_key)
            
            else:
                return AuthenticationResult(
                    success=False,
                    agent_identity=None,
                    method=auth_mode,
                    error=f"Unsupported authentication mode: {auth_mode}"
                )
                
        except Exception as e:
            logger.error(f"Authentication error: {e}", exc_info=True)
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod(self.config.auth_mode),
                error=f"Authentication error: {e}"
            )
    
    async def check_replay(self, request: Request) -> ReplayCheckResult:
        """
        Check request for replay attacks.
        
        Extracts nonce and timestamp from request headers:
        - X-Caracal-Nonce: Unique nonce for this request
        - X-Caracal-Timestamp: Unix timestamp when request was created
        
        Args:
            request: FastAPI Request object
            
        Returns:
            ReplayCheckResult indicating if request is allowed
        """
        if not self.replay_protection:
            return ReplayCheckResult(allowed=True)
        
        try:
            # Extract nonce from header
            nonce = request.headers.get("X-Caracal-Nonce")
            
            # Extract timestamp from header
            timestamp_str = request.headers.get("X-Caracal-Timestamp")
            timestamp = None
            if timestamp_str:
                try:
                    timestamp = int(timestamp_str)
                except ValueError:
                    logger.warning(f"Invalid timestamp format: {timestamp_str}")
            
            # Check replay protection
            return await self.replay_protection.check_request(
                nonce=nonce,
                timestamp=timestamp
            )
            
        except Exception as e:
            logger.error(f"Replay check error: {e}", exc_info=True)
            # Fail closed: deny on error
            return ReplayCheckResult(
                allowed=False,
                reason=f"Replay check error: {e}"
            )
    
    async def forward_request(self, request: Request, target_url: str) -> httpx.Response:
        """
        Forward authenticated request to target API.
        
        Args:
            request: FastAPI Request object
            target_url: Target API URL
            
        Returns:
            httpx.Response from target API
            
        Raises:
            httpx.HTTPError: If request forwarding fails
        """
        try:
            # Read request body
            body = await request.body()
            
            # Prepare headers (exclude Caracal-specific headers)
            headers = dict(request.headers)
            caracal_headers = [
                "x-caracal-target-url",
                "x-caracal-estimated-cost",
                "x-caracal-actual-cost",
                "x-caracal-resource-type",
                "x-caracal-nonce",
                "x-caracal-timestamp",
                "x-client-cert",
                "x-api-key",
                "host",  # Will be set by httpx
            ]
            for header in caracal_headers:
                headers.pop(header, None)
            
            # Forward request
            logger.debug(
                f"Forwarding request: method={request.method}, "
                f"url={target_url}, headers={len(headers)}"
            )
            
            response = await self.http_client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                timeout=self.config.request_timeout_seconds
            )
            
            logger.debug(
                f"Received response: status={response.status_code}, "
                f"size={len(response.content)} bytes"
            )
            
            return response
            
        except httpx.TimeoutException as e:
            logger.error(f"Request timeout forwarding to {target_url}: {e}")
            raise
        except httpx.HTTPError as e:
            logger.error(f"HTTP error forwarding to {target_url}: {e}", exc_info=True)
            raise
        except Exception as e:
            logger.error(f"Unexpected error forwarding to {target_url}: {e}", exc_info=True)
            raise
    
    async def start(self):
        """
        Start the gateway proxy server.
        
        Configures TLS if certificates are provided and starts the FastAPI app.
        """
        import uvicorn
        
        # Parse listen address
        host, port = self.config.listen_address.rsplit(":", 1)
        port = int(port)
        
        # Configure TLS
        ssl_config = None
        if self.config.tls_cert_file and self.config.tls_key_file:
            ssl_config = {
                "certfile": self.config.tls_cert_file,
                "keyfile": self.config.tls_key_file,
            }
            
            # Add CA cert for mTLS if provided
            if self.config.tls_ca_file:
                ssl_config["ca_certs"] = self.config.tls_ca_file
                ssl_config["cert_reqs"] = ssl.CERT_REQUIRED
            
            logger.info(
                f"Starting Gateway Proxy with TLS on {host}:{port}, "
                f"mTLS={self.config.tls_ca_file is not None}"
            )
        else:
            logger.warning(
                f"Starting Gateway Proxy without TLS on {host}:{port} "
                "(not recommended for production)"
            )
        
        # Start server
        config = uvicorn.Config(
            app=self.app,
            host=host,
            port=port,
            ssl_certfile=ssl_config["certfile"] if ssl_config else None,
            ssl_keyfile=ssl_config["keyfile"] if ssl_config else None,
            ssl_ca_certs=ssl_config.get("ca_certs") if ssl_config else None,
            ssl_cert_reqs=ssl_config.get("cert_reqs", ssl.CERT_NONE) if ssl_config else ssl.CERT_NONE,
            log_level="info",
        )
        
        server = uvicorn.Server(config)
        await server.serve()
    
    async def shutdown(self):
        """Shutdown the gateway proxy server."""
        logger.info("Shutting down Gateway Proxy")
        await self.http_client.aclose()
        logger.info("Gateway Proxy shutdown complete")
