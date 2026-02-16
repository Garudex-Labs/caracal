"""
Gateway Proxy server for Caracal Core v0.2.

Provides network-enforced policy enforcement through:
- HTTP/gRPC reverse proxy for intercepting API calls
- Authentication integration (mTLS, JWT, API keys)
- Policy evaluation before forwarding requests
- Replay protection
- Request forwarding to target APIs
- Metering event emission for enterprise usage tracking

Requirements: 1.1, 1.2, 1.6
"""

import asyncio
import logging
import ssl
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Dict, Any
from uuid import UUID

import httpx
from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse

from caracal.gateway.auth import Authenticator, AuthenticationMethod, AuthenticationResult
from caracal.gateway.replay_protection import ReplayProtection, ReplayCheckResult
from caracal.core.authority import AuthorityEvaluator
from caracal.core.metering import MeteringCollector
from caracal.kafka.producer import KafkaEventProducer
from caracal.core.error_handling import (
    get_error_handler,
    handle_error_with_denial,
    ErrorCategory,
    ErrorSeverity,
    ErrorContext
)
from caracal.exceptions import (
    CaracalError,
)
from caracal._version import __version__
from caracal.logging_config import get_logger
from caracal.monitoring.metrics import get_metrics_registry

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
        enable_kafka: Enable Kafka event publishing (default: False for v0.2 compatibility)
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
    enable_kafka: bool = False


class GatewayProxy:
    """
    Gateway Proxy server for network-enforced policy enforcement.
    
    Intercepts outbound API calls from agents and enforces mandates
    at the network layer. Provides authentication, authority evaluation,
    request forwarding, and metering.
    
    Requirements: 1.1, 1.2, 1.6
    """
    
    def __init__(
        self,
        config: GatewayConfig,
        authenticator: Authenticator,
        authority_evaluator: AuthorityEvaluator,
        metering_collector: MeteringCollector,
        replay_protection: Optional[ReplayProtection] = None,
        db_connection_manager: Optional[Any] = None,
        kafka_producer: Optional[KafkaEventProducer] = None,
        allowlist_manager: Optional[Any] = None
    ):
        """
        Initialize Gateway Proxy.
        
        Args:
            config: GatewayConfig with server settings
            authenticator: Authenticator for agent authentication
            authority_evaluator: AuthorityEvaluator for mandate checks
            metering_collector: MeteringCollector for usage tracking
            replay_protection: Optional ReplayProtection for replay attack prevention
            db_connection_manager: Optional DatabaseConnectionManager for health checks
            kafka_producer: Optional KafkaEventProducer for v0.3 event publishing
            allowlist_manager: Optional AllowlistManager for resource access control (v0.3)
        """
        self.config = config
        self.authenticator = authenticator
        self.authority_evaluator = authority_evaluator
        self.metering_collector = metering_collector
        self.replay_protection = replay_protection
        self.db_connection_manager = db_connection_manager
        self.kafka_producer = kafka_producer
        self.allowlist_manager = allowlist_manager
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Caracal Gateway Proxy",
            description="Network-enforced policy enforcement for AI agents",
            version=__version__
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
        self._degraded_mode_count = 0
        self._allowlist_blocks = 0
        self._allowlist_allows = 0
        
        logger.info(
            f"Initialized GatewayProxy with auth_mode={config.auth_mode}, "
            f"replay_protection={replay_protection is not None}, "
            f"kafka_enabled={config.enable_kafka}"
        )
    
    def _register_routes(self):
        """Register FastAPI routes."""
        
        @self.app.get("/health")
        async def health_check():
            """
            Health check endpoint for liveness/readiness probes.
            
            Checks:
            - Database connectivity (if db_connection_manager provided)
            - Kafka connectivity (if kafka_producer provided)
            - Redis connectivity (if redis_client provided)
            
            Returns:
            - 200 OK: Service is healthy and all dependencies are available
            - 503 Service Unavailable: Service is in degraded mode or unhealthy
            
            Requirements: 17.4, 22.5, Deployment
            """
            from caracal.monitoring.health import HealthChecker, HealthStatus
            
            # Create health checker with available components
            health_checker = HealthChecker(
                service_name="caracal-gateway-proxy",
                service_version=__version__,
                db_connection_manager=self.db_connection_manager,
                kafka_producer=self.kafka_producer,
                redis_client=getattr(self, 'redis_client', None)
            )
            
            # Perform health checks
            health_result = await health_checker.check_health()
            
            # Determine HTTP status code
            if health_result.status == HealthStatus.HEALTHY:
                status_code = status.HTTP_200_OK
            else:
                status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            
            return JSONResponse(
                status_code=status_code,
                content=health_result.to_dict()
            )
        
        @self.app.get("/metrics")
        async def metrics():
            """Prometheus metrics endpoint."""
            try:
                metrics_registry = get_metrics_registry()
                metrics_data = metrics_registry.generate_metrics()
                return Response(
                    content=metrics_data,
                    media_type=metrics_registry.get_content_type()
                )
            except RuntimeError:
                # Metrics not initialized - return empty response
                return Response(
                    content=b"# Metrics not initialized\n",
                    media_type="text/plain"
                )
        
        @self.app.get("/stats")
        async def get_stats():
            """Get gateway statistics."""
            stats = {
                "requests_total": self._request_count,
                "requests_allowed": self._allowed_count,
                "requests_denied": self._denied_count,
                "auth_failures": self._auth_failures,
                "replay_blocks": self._replay_blocks,
                "degraded_mode_requests": self._degraded_mode_count,
                "allowlist_blocks": self._allowlist_blocks,
                "allowlist_allows": self._allowlist_allows,
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
            3. Evaluate authority policy
            4. Forward request to target API
            5. Emit metering event
            6. Return response
            """
            return await self._handle_request(request, path)
    
    async def _handle_request(self, request: Request, path: str) -> Response:
        """
        Handle incoming request with authentication, authority check, and forwarding.
        
        Args:
            request: FastAPI Request object
            path: Request path
            
        Returns:
            Response from target API or error response
        """
        start_time = time.time()
        self._request_count += 1
        
        # Get metrics registry (if available)
        try:
            metrics = get_metrics_registry()
        except RuntimeError:
            metrics = None
        
        # Track in-flight requests
        if metrics:
            metrics.gateway_requests_in_flight.inc()
        
        try:
            # 1. Authenticate agent
            auth_result = await self.authenticate_agent(request)
            
            if not auth_result.success:
                self._auth_failures += 1
                
                # Record auth failure metric
                if metrics:
                    metrics.record_auth_failure(
                        auth_method=auth_result.method.value,
                        reason=auth_result.error or "unknown"
                    )
                
                # Handle authentication failure with fail-closed semantics
                error_handler = get_error_handler("gateway-proxy")
                auth_error = Exception(auth_result.error or "Authentication failed")
                context = error_handler.handle_error(
                    error=auth_error,
                    category=ErrorCategory.AUTHENTICATION,
                    operation="authenticate_agent",
                    request_id=request.headers.get("X-Request-ID"),
                    metadata={
                        "auth_method": auth_result.method.value,
                        "path": path,
                        "method": request.method
                    },
                    severity=ErrorSeverity.CRITICAL
                )
                
                error_response = error_handler.create_error_response(context, include_details=False)
                
                logger.warning(
                    f"Authentication failed (fail-closed): {auth_result.error}, "
                    f"method={auth_result.method}"
                )
                
                # Record request metric
                if metrics:
                    duration = time.time() - start_time
                    metrics.record_gateway_request(
                        method=request.method,
                        status_code=401,
                        auth_method=auth_result.method.value,
                        duration_seconds=duration
                    )
                
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content=error_response.to_dict()
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
                    
                    # Record replay block metric
                    if metrics:
                        metrics.record_replay_block(reason=replay_result.reason or "unknown")
                    
                    # Handle replay attack with fail-closed semantics
                    error_handler = get_error_handler("gateway-proxy")
                    replay_error = Exception(replay_result.reason or "Replay attack detected")
                    context = error_handler.handle_error(
                        error=replay_error,
                        category=ErrorCategory.AUTHORIZATION,
                        operation="check_replay",
                        agent_id=str(agent.agent_id),
                        request_id=request.headers.get("X-Request-ID"),
                        metadata={
                            "agent_name": agent.name,
                            "path": path,
                            "method": request.method
                        },
                        severity=ErrorSeverity.CRITICAL
                    )
                    
                    error_response = error_handler.create_error_response(context, include_details=False)
                    
                    logger.warning(
                        f"Replay attack blocked (fail-closed) for agent {agent.agent_id}: {replay_result.reason}"
                    )
                    
                    # Record request metric
                    if metrics:
                        duration = time.time() - start_time
                        metrics.record_gateway_request(
                            method=request.method,
                            status_code=403,
                            auth_method=auth_result.method.value,
                            duration_seconds=duration
                        )
                    
                    return JSONResponse(
                        status_code=status.HTTP_403_FORBIDDEN,
                        content=error_response.to_dict()
                    )
            
            # 3. Check Authority (Mandate Validation)
            # Extract Mandate ID from headers
            mandate_id_str = request.headers.get("X-Caracal-Mandate-ID")
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

            if not mandate_id_str:
                logger.warning(f"Missing X-Caracal-Mandate-ID header for agent {agent.agent_id}")
                return JSONResponse(
                    status_code=status.HTTP_403_FORBIDDEN,
                    content={
                        "error": "missing_mandate_id",
                        "message": "X-Caracal-Mandate-ID header is required"
                    }
                )
                
            try:
                # Validate Mandate ID format
                from uuid import UUID
                mandate_id = UUID(mandate_id_str)
            except ValueError:
                logger.warning(f"Invalid mandate_id format: {mandate_id_str}")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={
                        "error": "invalid_mandate_id",
                        "message": "Invalid mandate_id format"
                    }
                )

            # Fetch and Validate Mandate
            try:
                mandate = self.authority_evaluator._get_mandate_with_cache(mandate_id)
                if not mandate:
                    logger.warning(f"Mandate not found: {mandate_id}")
                    return JSONResponse(
                        status_code=status.HTTP_403_FORBIDDEN,
                        content={
                            "error": "mandate_not_found",
                            "message": f"Mandate {mandate_id} not found"
                        }
                    )
                
                # Validate authority for the target URL
                # Action: "call" (generic API call), Resource: target_url
                decision = self.authority_evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="call",
                    requested_resource=target_url
                )
                
                if not decision.allowed:
                    self._denied_count += 1
                    logger.warning(
                        f"Authority denied for agent {agent.agent_id}: {decision.reason}"
                    )
                    return JSONResponse(
                        status_code=status.HTTP_403_FORBIDDEN,
                        content={
                            "error": "authority_denied",
                            "message": decision.reason,
                            "mandate_id": str(mandate_id)
                        }
                    )
                
                logger.info(
                    f"Authority granted for agent {agent.agent_id}, resource {target_url} (mandate {mandate_id})"
                )
                
            except Exception as e:
                # Fail closed on validation error
                logger.error(f"Authority validation failed for agent {agent.agent_id}: {e}", exc_info=True)
                return JSONResponse(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    content={
                        "error": "authority_validation_failed",
                        "message": "Internal error during authority validation"
                    }
                )

            # 4. Forward request to target API
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
            
            # 5. Emit metering event (usage only)
            try:
                # datetime is already imported at module level
                from ase.protocol import MeteringEvent
                from decimal import Decimal
                
                # Determine resource type
                resource_type = request.headers.get("X-Caracal-Resource-Type", "api_call")
                
                # Calculate quantity (e.g. 1 call or bytes)
                response_size_bytes = len(response.content)
                quantity = Decimal("1") # Count as 1 call by default
                
                # v0.5: Publish metering event to Kafka if enabled
                if self.config.enable_kafka and self.kafka_producer:
                    try:
                        await self.kafka_producer.publish_metering_event(
                            agent_id=str(agent.agent_id),
                            resource_type=resource_type,
                            quantity=quantity,
                            metadata={
                                "method": request.method,
                                "path": path,
                                "target_url": target_url,
                                "status_code": str(response.status_code),
                                "response_size_bytes": str(response_size_bytes),
                                "mandate_id": str(mandate_id)
                            },
                            timestamp=datetime.utcnow()
                        )
                        
                        logger.info(
                            f"Published metering event to Kafka: agent={agent.agent_id}, "
                            f"resource={resource_type}"
                        )
                    except Exception as kafka_error:
                        logger.error(f"Failed to publish Kafka event: {kafka_error}")
                        # Fallback to direct collection logic if needed, or just log error
                        # For now, we'll try direct collection via metering_collector
                        
                        metering_event = MeteringEvent(
                            agent_id=str(agent.agent_id),
                            resource_type=resource_type,
                            quantity=quantity,
                            timestamp=datetime.utcnow(),
                            metadata={
                                "method": request.method,
                                "path": path,
                                "target_url": target_url,
                                "status_code": str(response.status_code),
                                "response_size_bytes": str(response_size_bytes),
                                "mandate_id": str(mandate_id)
                            }
                        )
                        self.metering_collector.collect_event(metering_event)

                else:
                    # Direct collection
                    metering_event = MeteringEvent(
                        agent_id=str(agent.agent_id),
                        resource_type=resource_type,
                        quantity=quantity,
                        timestamp=datetime.utcnow(),
                        metadata={
                            "method": request.method,
                            "path": path,
                            "target_url": target_url,
                            "status_code": str(response.status_code),
                            "response_size_bytes": str(response_size_bytes),
                            "mandate_id": str(mandate_id)
                        }
                    )
                    
                    self.metering_collector.collect_event(metering_event)
                
                logger.info(
                    f"Emitted metering event for agent {agent.agent_id}, "
                    f"resource={resource_type}, quantity={quantity}"
                )
            except Exception as e:
                logger.error(f"Failed to emit metering event for agent {agent.agent_id}: {e}", exc_info=True)
                # Don't fail the request if metering fails
            
            # 6. Return response
            self._allowed_count += 1
            duration_ms = (time.time() - start_time) * 1000
            logger.info(
                f"Request completed for agent {agent.agent_id}, "
                f"status={response.status_code}, duration={duration_ms:.2f}ms, "
                f"degraded_mode={used_cache}"
            )
            
            # Record request metric
            if metrics:
                duration = time.time() - start_time
                metrics.record_gateway_request(
                    method=request.method,
                    status_code=response.status_code,
                    auth_method=auth_result.method.value,
                    duration_seconds=duration
                )
            
            # Prepare response headers
            response_headers = dict(response.headers)
            
            # Add degraded mode headers if cache was used (Requirement 16.6)
            if used_cache and cache_age_seconds is not None:
                response_headers["X-Caracal-Degraded-Mode"] = "true"
                response_headers["X-Caracal-Cache-Age"] = str(int(cache_age_seconds))
                response_headers["X-Caracal-Cache-Warning"] = "Policy evaluated using cached data due to service unavailability"
            
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=response_headers,
                media_type=response.headers.get("content-type")
            )
            
        except Exception as e:
            # Catch-all for unexpected errors - fail closed
            error_handler = get_error_handler("gateway-proxy")
            context = error_handler.handle_error(
                error=e,
                category=ErrorCategory.UNKNOWN,
                operation="handle_request",
                agent_id=None,  # May not have authenticated yet
                request_id=request.headers.get("X-Request-ID"),
                metadata={
                    "path": path,
                    "method": request.method
                },
                severity=ErrorSeverity.CRITICAL
            )
            
            error_response = error_handler.create_error_response(context, include_details=False)
            
            logger.error(
                f"Unexpected error handling request (fail-closed): {e}",
                exc_info=True
            )
            
            # Record request metric
            if metrics:
                duration = time.time() - start_time
                metrics.record_gateway_request(
                    method=request.method,
                    status_code=500,
                    auth_method="unknown",
                    duration_seconds=duration
                )
            
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content=error_response.to_dict()
            )
        finally:
            # Decrement in-flight requests
            if metrics:
                metrics.gateway_requests_in_flight.dec()
    
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
            # Fail closed: deny on authentication error (Requirement 23.3)
            error_handler = get_error_handler("gateway-proxy")
            error_handler.handle_error(
                error=e,
                category=ErrorCategory.AUTHENTICATION,
                operation="authenticate_agent",
                request_id=request.headers.get("X-Request-ID"),
                metadata={
                    "auth_mode": self.config.auth_mode,
                    "path": request.url.path,
                    "method": request.method
                },
                severity=ErrorSeverity.CRITICAL
            )
            
            logger.error(
                f"Authentication error (fail-closed): {e}",
                exc_info=True
            )
            
            return AuthenticationResult(
                success=False,
                agent_identity=None,
                method=AuthenticationMethod(self.config.auth_mode),
                error=f"Authentication error (fail-closed): {type(e).__name__}"
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
            # Fail closed: deny on error (Requirement 23.3)
            error_handler = get_error_handler("gateway-proxy")
            error_handler.handle_error(
                error=e,
                category=ErrorCategory.AUTHORIZATION,
                operation="check_replay",
                request_id=request.headers.get("X-Request-ID"),
                metadata={
                    "path": request.url.path,
                    "method": request.method
                },
                severity=ErrorSeverity.HIGH
            )
            
            logger.error(
                f"Replay check error (fail-closed): {e}",
                exc_info=True
            )
            
            return ReplayCheckResult(
                allowed=False,
                reason=f"Replay check error (fail-closed): {type(e).__name__}"
            )
    
    async def forward_request(self, request: Request, target_url: str) -> httpx.Response:
        """
        Forward authenticated request to target API with streaming support.
        
        This method forwards the request to the target API and handles both
        regular and streaming responses. For streaming responses, the entire
        response is read into memory before returning to ensure we can
        accurately record resource consumption for metering.
        
        Args:
            request: FastAPI Request object
            target_url: Target API URL
            
        Returns:
            httpx.Response from target API with content fully read
            
        Raises:
            httpx.HTTPError: If request forwarding fails
            
        Requirements: 1.4
        """
        try:
            # Read request body
            body = await request.body()
            
            # Prepare headers (exclude Caracal-specific headers)
            # Convert to lowercase for case-insensitive comparison
            headers = {k.lower(): v for k, v in request.headers.items()}
            caracal_headers = [
                "x-caracal-target-url",
                "x-caracal-resource-type",
                "x-caracal-nonce",
                "x-caracal-timestamp",
                "x-client-cert",
                "x-api-key",
                "host",  # Will be set by httpx
            ]
            for header in caracal_headers:
                headers.pop(header, None)
            
            # Forward request with streaming enabled
            logger.debug(
                f"Forwarding request: method={request.method}, "
                f"url={target_url}, headers={len(headers)}"
            )
            
            # Use stream=True to handle large responses efficiently
            async with self.http_client.stream(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                timeout=self.config.request_timeout_seconds
            ) as response:
                # Read the response content in chunks for streaming support
                # This allows us to handle large responses without loading
                # everything into memory at once
                content_chunks = []
                async for chunk in response.aiter_bytes():
                    content_chunks.append(chunk)
                
                # Combine chunks into full content
                full_content = b''.join(content_chunks)
                
                logger.debug(
                    f"Received response: status={response.status_code}, "
                    f"size={len(full_content)} bytes"
                )
                
                # Create a new Response object with the full content
                # We need to do this because the streaming response can't be reused
                return httpx.Response(
                    status_code=response.status_code,
                    headers=response.headers,
                    content=full_content,
                    request=response.request
                )
            
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
