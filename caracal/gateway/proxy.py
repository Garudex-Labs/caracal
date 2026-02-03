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
from datetime import datetime
from typing import Optional, Dict, Any
from uuid import UUID

import httpx
from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse

from caracal.gateway.auth import Authenticator, AuthenticationMethod, AuthenticationResult
from caracal.gateway.replay_protection import ReplayProtection, ReplayCheckResult
from caracal.gateway.cache import PolicyCache, PolicyCacheConfig, CachedPolicy
from caracal.core.policy import PolicyEvaluator, PolicyDecision
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
    BudgetExceededError,
    PolicyEvaluationError,
)
from caracal.logging_config import get_logger
from caracal.monitoring.metrics import get_metrics_registry, PolicyDecisionType

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
        enable_policy_cache: Enable policy cache for degraded mode (default: True)
        policy_cache_ttl: TTL for cached policies in seconds (default: 60)
        policy_cache_max_size: Maximum number of cached policies (default: 10000)
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
    enable_policy_cache: bool = True
    policy_cache_ttl: int = 60
    policy_cache_max_size: int = 10000
    enable_kafka: bool = False


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
        replay_protection: Optional[ReplayProtection] = None,
        policy_cache: Optional[PolicyCache] = None,
        db_connection_manager: Optional[Any] = None,
        kafka_producer: Optional[KafkaEventProducer] = None,
        allowlist_manager: Optional[Any] = None
    ):
        """
        Initialize Gateway Proxy.
        
        Args:
            config: GatewayConfig with server settings
            authenticator: Authenticator for agent authentication
            policy_evaluator: PolicyEvaluator for budget checks
            metering_collector: MeteringCollector for final charges
            replay_protection: Optional ReplayProtection for replay attack prevention
            policy_cache: Optional PolicyCache for degraded mode operation
            db_connection_manager: Optional DatabaseConnectionManager for health checks
            kafka_producer: Optional KafkaEventProducer for v0.3 event publishing
            allowlist_manager: Optional AllowlistManager for resource access control (v0.3)
        """
        self.config = config
        self.authenticator = authenticator
        self.policy_evaluator = policy_evaluator
        self.metering_collector = metering_collector
        self.replay_protection = replay_protection
        self.db_connection_manager = db_connection_manager
        self.kafka_producer = kafka_producer
        self.allowlist_manager = allowlist_manager
        
        # Initialize policy cache if enabled and not provided
        if config.enable_policy_cache and policy_cache is None:
            cache_config = PolicyCacheConfig(
                ttl_seconds=config.policy_cache_ttl,
                max_size=config.policy_cache_max_size
            )
            self.policy_cache = PolicyCache(cache_config)
            logger.info(
                f"Initialized policy cache: ttl={cache_config.ttl_seconds}s, "
                f"max_size={cache_config.max_size}"
            )
        else:
            self.policy_cache = policy_cache
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Caracal Gateway Proxy",
            description="Network-enforced policy enforcement for AI agents",
            version="0.3.0"
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
            f"policy_cache={self.policy_cache is not None}, "
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
            - Policy cache status (if enabled)
            
            Returns:
            - 200 OK: Service is healthy and all dependencies are available
            - 503 Service Unavailable: Service is in degraded mode or unhealthy
            
            Requirements: 17.4, 22.5, Deployment
            """
            from caracal.monitoring.health import HealthChecker, HealthStatus
            
            # Create health checker with available components
            health_checker = HealthChecker(
                service_name="caracal-gateway-proxy",
                service_version="0.3.0",
                db_connection_manager=self.db_connection_manager,
                kafka_producer=self.kafka_producer,
                redis_client=getattr(self, 'redis_client', None)
            )
            
            # Perform health checks
            health_result = await health_checker.check_health()
            
            # Add policy cache status
            if self.policy_cache:
                cache_stats = self.policy_cache.get_stats()
                health_result.checks.append(
                    type('HealthCheckResult', (), {
                        'name': 'policy_cache',
                        'status': HealthStatus.HEALTHY,
                        'message': 'Policy cache enabled',
                        'details': {
                            'size': cache_stats.size,
                            'max_size': cache_stats.max_size,
                            'hit_rate': cache_stats.hit_rate
                        },
                        'to_dict': lambda self: {
                            'name': self.name,
                            'status': self.status.value,
                            'message': self.message,
                            'details': self.details
                        }
                    })()
                )
            
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
            
            # Add policy cache stats if available
            if self.policy_cache:
                cache_stats = self.policy_cache.get_stats()
                stats["policy_cache"] = {
                    "hit_count": cache_stats.hit_count,
                    "miss_count": cache_stats.miss_count,
                    "hit_rate": cache_stats.hit_rate,
                    "size": cache_stats.size,
                    "max_size": cache_stats.max_size,
                    "eviction_count": cache_stats.eviction_count,
                    "invalidation_count": cache_stats.invalidation_count,
                }
            
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
            
            # 2.5. Check resource allowlist (v0.3)
            # Extract target URL for allowlist check
            target_url = request.headers.get("X-Caracal-Target-URL")
            
            if self.allowlist_manager and target_url:
                try:
                    allowlist_decision = self.allowlist_manager.check_resource(
                        agent_id=agent.agent_id,
                        resource_url=target_url
                    )
                    
                    if not allowlist_decision.allowed:
                        self._allowlist_blocks += 1
                        
                        logger.warning(
                            f"Resource {target_url} denied by allowlist for agent {agent.agent_id}: "
                            f"{allowlist_decision.reason}"
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
                            content={
                                "error": "resource_not_allowed",
                                "message": allowlist_decision.reason,
                                "resource": target_url
                            }
                        )
                    
                    self._allowlist_allows += 1
                    
                    logger.info(
                        f"Resource {target_url} allowed by allowlist for agent {agent.agent_id}: "
                        f"{allowlist_decision.reason}"
                    )
                    
                except Exception as allowlist_error:
                    # Log error but don't fail the request if allowlist check fails
                    # This ensures backward compatibility and prevents allowlist issues
                    # from blocking legitimate requests
                    logger.error(
                        f"Allowlist check failed for agent {agent.agent_id}, allowing request: {allowlist_error}",
                        exc_info=True
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
            # If policy service is unavailable, use cached policy for degraded mode
            policy_decision = None
            used_cache = False
            cache_age_seconds = None
            
            # Time policy evaluation
            policy_eval_start = time.time()
            
            try:
                policy_decision = self.policy_evaluator.check_budget(
                    agent_id=str(agent.agent_id),
                    estimated_cost=estimated_cost
                )
                
                # Record policy evaluation metric
                if metrics:
                    policy_eval_duration = time.time() - policy_eval_start
                    decision_type = PolicyDecisionType.ALLOWED if policy_decision.allowed else PolicyDecisionType.DENIED
                    metrics.record_policy_evaluation(
                        decision=decision_type,
                        agent_id=str(agent.agent_id),
                        duration_seconds=policy_eval_duration
                    )
                
                # Cache the policy decision for future degraded mode use
                if self.policy_cache and policy_decision.allowed:
                    # Get the policy from policy store to cache it
                    try:
                        policies = self.policy_evaluator.policy_store.get_policies(str(agent.agent_id))
                        if policies:
                            await self.policy_cache.put(str(agent.agent_id), policies[0])
                    except Exception as cache_error:
                        logger.warning(f"Failed to cache policy for agent {agent.agent_id}: {cache_error}")
                
            except PolicyEvaluationError as e:
                # Policy service unavailable - try degraded mode with cache
                # Handle with fail-closed semantics
                error_handler = get_error_handler("gateway-proxy")
                context = error_handler.handle_error(
                    error=e,
                    category=ErrorCategory.POLICY_EVALUATION,
                    operation="check_budget",
                    agent_id=str(agent.agent_id),
                    request_id=request.headers.get("X-Request-ID"),
                    metadata={
                        "agent_name": agent.name,
                        "estimated_cost": str(estimated_cost) if estimated_cost else None,
                        "path": path,
                        "method": request.method
                    },
                    severity=ErrorSeverity.HIGH
                )
                
                logger.warning(
                    f"Policy evaluation failed for agent {agent.agent_id}: {e}, "
                    f"attempting degraded mode with cache"
                )
                
                # Record policy evaluation error metric
                if metrics:
                    policy_eval_duration = time.time() - policy_eval_start
                    metrics.record_policy_evaluation(
                        decision=PolicyDecisionType.ERROR,
                        agent_id=str(agent.agent_id),
                        duration_seconds=policy_eval_duration
                    )
                
                if self.policy_cache:
                    cached_policy = await self.policy_cache.get(str(agent.agent_id))
                    
                    if cached_policy:
                        # Use cached policy for degraded mode operation
                        used_cache = True
                        self._degraded_mode_count += 1
                        cache_age_seconds = (datetime.utcnow() - cached_policy.cached_at).total_seconds()
                        
                        # Record degraded mode metric
                        if metrics:
                            metrics.record_degraded_mode_request()
                        
                        logger.warning(
                            f"Using cached policy for agent {agent.agent_id} in degraded mode, "
                            f"cache_age={cache_age_seconds:.1f}s"
                        )
                        
                        # Perform simplified budget check with cached policy
                        # Note: This doesn't check current spending or provisional charges
                        # It's a best-effort degraded mode operation
                        from decimal import Decimal
                        limit = Decimal(cached_policy.policy.limit_amount)
                        
                        # Allow request if estimated cost is within limit
                        # This is a simplified check - we can't query current spending in degraded mode
                        if estimated_cost is None or estimated_cost <= limit:
                            policy_decision = PolicyDecision(
                                allowed=True,
                                reason="Within budget (degraded mode - cached policy)",
                                remaining_budget=limit - (estimated_cost if estimated_cost else Decimal('0')),
                                provisional_charge_id=None  # No provisional charge in degraded mode
                            )
                        else:
                            policy_decision = PolicyDecision(
                                allowed=False,
                                reason=f"Estimated cost {estimated_cost} exceeds cached policy limit {limit} (degraded mode)",
                                remaining_budget=Decimal('0')
                            )
                    else:
                        # No cached policy available - fail closed
                        error_response = error_handler.create_error_response(context, include_details=False)
                        
                        logger.error(
                            f"Policy evaluation failed and no cached policy available for agent {agent.agent_id}, "
                            f"failing closed (Requirement 23.3)"
                        )
                        
                        # Record request metric
                        if metrics:
                            duration = time.time() - start_time
                            metrics.record_gateway_request(
                                method=request.method,
                                status_code=503,
                                auth_method=auth_result.method.value,
                                duration_seconds=duration
                            )
                        
                        return JSONResponse(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            content=error_response.to_dict()
                        )
                else:
                    # Policy cache not enabled - fail closed
                    error_response = error_handler.create_error_response(context, include_details=False)
                    
                    logger.error(
                        f"Policy evaluation failed for agent {agent.agent_id} and policy cache not enabled, "
                        f"failing closed (Requirement 23.3)"
                    )
                    
                    # Record request metric
                    if metrics:
                        duration = time.time() - start_time
                        metrics.record_gateway_request(
                            method=request.method,
                            status_code=503,
                            auth_method=auth_result.method.value,
                            duration_seconds=duration
                        )
                    
                    return JSONResponse(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        content=error_response.to_dict()
                    )
            
            # Return 403 on budget denial (Requirement 1.5)
            if not policy_decision.allowed:
                self._denied_count += 1
                logger.info(
                    f"Budget check denied for agent {agent.agent_id}: {policy_decision.reason}"
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
                    content={
                        "error": "budget_exceeded",
                        "message": policy_decision.reason,
                        "remaining_budget": str(policy_decision.remaining_budget) if policy_decision.remaining_budget is not None else None
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
                
                # Record request metric
                if metrics:
                    duration = time.time() - start_time
                    metrics.record_gateway_request(
                        method=request.method,
                        status_code=400,
                        auth_method=auth_result.method.value,
                        duration_seconds=duration
                    )
                
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
                
                # Record request metric
                if metrics:
                    duration = time.time() - start_time
                    metrics.record_gateway_request(
                        method=request.method,
                        status_code=502,
                        auth_method=auth_result.method.value,
                        duration_seconds=duration
                    )
                
                return JSONResponse(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    content={
                        "error": "request_forwarding_failed",
                        "message": str(e)
                    }
                )
            
            # 5. Emit final charge (metering event) after response
            # This ensures accurate cost tracking based on actual resource consumption
            # Requirements: 1.4, 15.1, 15.2, 15.3
            try:
                from decimal import Decimal
                from ase.protocol import MeteringEvent
                # datetime is already imported at module level
                
                # Extract actual cost from response headers if provided
                # Otherwise, use the estimated cost from the provisional charge
                actual_cost_str = response.headers.get("X-Caracal-Actual-Cost")
                if actual_cost_str:
                    try:
                        actual_cost = Decimal(actual_cost_str)
                    except (ValueError, Exception) as e:
                        logger.warning(f"Invalid actual cost header: {actual_cost_str}, using estimated cost")
                        actual_cost = estimated_cost if estimated_cost else Decimal("0")
                else:
                    # Use estimated cost if no actual cost provided
                    actual_cost = estimated_cost if estimated_cost else Decimal("0")
                
                # Determine resource type from request headers or default to api_call
                resource_type = request.headers.get("X-Caracal-Resource-Type", "api_call")
                
                # Calculate quantity based on response size (bytes)
                # This provides a basic metering mechanism when no explicit cost is provided
                response_size_bytes = len(response.content)
                quantity = Decimal(str(response_size_bytes)) if actual_cost == Decimal("0") else Decimal("1")
                
                # v0.3: Publish metering event to Kafka if enabled
                if self.config.enable_kafka and self.kafka_producer:
                    try:
                        await self.kafka_producer.publish_metering_event(
                            agent_id=str(agent.agent_id),
                            resource_type=resource_type,
                            quantity=quantity,
                            cost=actual_cost,
                            currency="USD",
                            provisional_charge_id=str(policy_decision.provisional_charge_id) if policy_decision.provisional_charge_id else None,
                            metadata={
                                "method": request.method,
                                "path": path,
                                "target_url": target_url,
                                "status_code": str(response.status_code),
                                "response_size_bytes": str(response_size_bytes),
                                "estimated_cost": str(estimated_cost) if estimated_cost else None,
                                "actual_cost": str(actual_cost),
                            },
                            timestamp=datetime.utcnow()
                        )
                        
                        logger.info(
                            f"Published metering event to Kafka for agent {agent.agent_id}, "
                            f"resource={resource_type}, quantity={quantity}, cost={actual_cost}"
                        )
                        
                        # Also publish policy decision event
                        await self.kafka_producer.publish_policy_decision(
                            agent_id=str(agent.agent_id),
                            decision="allowed",
                            reason=policy_decision.reason,
                            estimated_cost=estimated_cost,
                            remaining_budget=policy_decision.remaining_budget,
                            metadata={
                                "method": request.method,
                                "path": path,
                                "target_url": target_url,
                            },
                            timestamp=datetime.utcnow()
                        )
                        
                    except Exception as kafka_error:
                        logger.error(
                            f"Failed to publish events to Kafka for agent {agent.agent_id}: {kafka_error}",
                            exc_info=True
                        )
                        # Fall back to direct ledger write if Kafka fails
                        logger.warning("Falling back to direct ledger write due to Kafka failure")
                        
                        # Create metering event for direct write
                        metering_event = MeteringEvent(
                            agent_id=str(agent.agent_id),
                            resource_type=resource_type,
                            quantity=quantity,
                            timestamp=datetime.utcnow(),
                            metadata={
                                "method": request.method,
                                "path": path,
                                "target_url": target_url,
                                "status_code": response.status_code,
                                "response_size_bytes": response_size_bytes,
                                "estimated_cost": str(estimated_cost) if estimated_cost else None,
                                "actual_cost": str(actual_cost),
                                "provisional_charge_id": str(policy_decision.provisional_charge_id) if policy_decision.provisional_charge_id else None
                            }
                        )
                        
                        # Collect event with provisional charge ID for reconciliation
                        self.metering_collector.collect_event(
                            metering_event,
                            provisional_charge_id=str(policy_decision.provisional_charge_id) if policy_decision.provisional_charge_id else None
                        )
                else:
                    # v0.2 compatibility: Direct ledger write
                    # Create metering event with comprehensive metadata
                    metering_event = MeteringEvent(
                        agent_id=str(agent.agent_id),
                        resource_type=resource_type,
                        quantity=quantity,
                        timestamp=datetime.utcnow(),
                        metadata={
                            "method": request.method,
                            "path": path,
                            "target_url": target_url,
                            "status_code": response.status_code,
                            "response_size_bytes": response_size_bytes,
                            "estimated_cost": str(estimated_cost) if estimated_cost else None,
                            "actual_cost": str(actual_cost),
                            "provisional_charge_id": str(policy_decision.provisional_charge_id) if policy_decision.provisional_charge_id else None
                        }
                    )
                    
                    # Collect event with provisional charge ID for reconciliation
                    # This will release the provisional charge and adjust budget if costs differ
                    self.metering_collector.collect_event(
                        metering_event,
                        provisional_charge_id=str(policy_decision.provisional_charge_id) if policy_decision.provisional_charge_id else None
                    )
                
                logger.info(
                    f"Emitted final charge for agent {agent.agent_id}, "
                    f"resource={resource_type}, quantity={quantity}, "
                    f"estimated_cost={estimated_cost}, actual_cost={actual_cost}, "
                    f"provisional_charge_id={policy_decision.provisional_charge_id}"
                )
            except Exception as e:
                logger.error(f"Failed to emit final charge for agent {agent.agent_id}: {e}", exc_info=True)
                # Don't fail the request if metering fails - the provisional charge
                # will be cleaned up by the background job if not released
            
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
        response is read into memory before returning to ensure we can emit
        accurate final charges based on actual resource consumption.
        
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
