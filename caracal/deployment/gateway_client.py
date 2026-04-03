"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Gateway Client for Enterprise Edition.

Handles provider communication through enterprise gateway with JWT authentication,
streaming support, connection pooling, quota monitoring, and request queuing.
"""

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from caracal.deployment.config_manager import ConfigManager
from caracal.deployment.exceptions import (
    GatewayAuthenticationError,
    GatewayAuthorizationError,
    GatewayConnectionError,
    GatewayQuotaExceededError,
    GatewayTimeoutError,
    GatewayUnavailableError,
)

logger = structlog.get_logger(__name__)


class RequestPriority(str, Enum):
    """Request priority levels for queuing."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class ProviderRequest:
    """Provider request data model."""
    provider: str
    method: str
    endpoint: str
    resource: Optional[str] = None
    action: Optional[str] = None
    params: Dict[str, Any] = field(default_factory=dict)
    headers: Dict[str, str] = field(default_factory=dict)
    body: Optional[Dict[str, Any]] = None
    stream: bool = False


@dataclass
class ProviderResponse:
    """Provider response data model."""
    status_code: int
    data: Dict[str, Any]
    error: Optional[str] = None
    latency_ms: float = 0.0


@dataclass
class ProviderInfo:
    """Provider information from gateway."""
    name: str
    provider_type: str
    available: bool
    quota_remaining: Optional[int] = None
    auth_scheme: Optional[str] = None
    version: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    provider_definition: Optional[str] = None
    resources: List[str] = field(default_factory=list)
    actions: List[str] = field(default_factory=list)

    @property
    def service_type(self) -> str:
        """Alias for provider_type to support service-agnostic terminology."""
        return self.provider_type

    @property
    def status(self) -> str:
        """Compatibility status field consumed by CLI table rendering."""
        return "healthy" if self.available else "unavailable"


@dataclass
class GatewayHealthCheck:
    """Gateway health check result."""
    healthy: bool
    latency_ms: float
    authenticated: bool
    error: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class QuotaStatus:
    """Gateway quota status."""
    total_quota: int
    used_quota: int
    remaining_quota: int
    reset_at: datetime
    percentage_used: float


@dataclass
class QueuedRequest:
    """Queued request when gateway unavailable."""
    request: ProviderRequest
    priority: RequestPriority
    queued_at: datetime
    ttl_seconds: int
    retry_count: int = 0
    
    def is_expired(self) -> bool:
        """Check if request has expired based on TTL."""
        elapsed = (datetime.now() - self.queued_at).total_seconds()
        return elapsed > self.ttl_seconds


@dataclass
class JWTToken:
    """JWT token with expiration tracking."""
    token: str
    expires_at: datetime
    refresh_token: Optional[str] = None
    
    def is_expired(self, buffer_seconds: int = 60) -> bool:
        """
        Check if token is expired or will expire soon.
        
        Args:
            buffer_seconds: Refresh buffer time before actual expiration
            
        Returns:
            True if token is expired or will expire within buffer time
        """
        return datetime.now() >= (self.expires_at - timedelta(seconds=buffer_seconds))


class GatewayClient:
    """
    Gateway Client for Enterprise Edition.
    
    Handles provider communication through enterprise gateway with:
    - JWT token management with automatic refresh
    - Provider API proxying through gateway
    - Streaming response support for long-running operations
    - Connection pooling for efficiency
    - Quota monitoring to prevent overuse
    - Request queuing when gateway unavailable
    """
    
    def __init__(
        self,
        gateway_url: str,
        config_manager: Optional[ConfigManager] = None,
        workspace: str = "default",
        max_queue_size: int = 1000,
        default_ttl_seconds: int = 3600
    ):
        """
        Initialize the gateway client.
        
        Args:
            gateway_url: Gateway base URL
            config_manager: Configuration manager instance
            workspace: Workspace name
            max_queue_size: Maximum number of queued requests
            default_ttl_seconds: Default TTL for queued requests
        """
        self.gateway_url = gateway_url.rstrip('/')
        self.config_manager = config_manager or ConfigManager()
        self.workspace = workspace
        self.max_queue_size = max_queue_size
        self.default_ttl_seconds = default_ttl_seconds
        
        # JWT token management
        self._token: Optional[JWTToken] = None
        self._token_lock = asyncio.Lock()
        
        # Request queue for offline scenarios
        self._request_queue: deque[QueuedRequest] = deque(maxlen=max_queue_size)
        self._queue_lock = asyncio.Lock()
        
        # HTTP client with connection pooling
        self._client: Optional[httpx.AsyncClient] = None
        
        # Quota tracking
        self._quota_status: Optional[QuotaStatus] = None
        self._last_quota_check: Optional[datetime] = None
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create async HTTP client with connection pooling."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                limits=httpx.Limits(
                    max_keepalive_connections=20,
                    max_connections=50,
                    keepalive_expiry=30.0
                ),
                http2=True  # Enable HTTP/2 for better performance
            )
        return self._client
    
    async def close(self) -> None:
        """Close HTTP client and cleanup resources."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
    
    async def _get_token(self) -> str:
        """
        Get valid JWT token, refreshing if necessary.
        
        Returns:
            Valid JWT token
            
        Raises:
            GatewayAuthenticationError: If authentication fails
        """
        async with self._token_lock:
            # Check if we have a valid token
            if self._token is not None and not self._token.is_expired():
                return self._token.token
            
            # Need to refresh or get new token
            if self._token is not None and self._token.refresh_token:
                try:
                    await self._refresh_token()
                    return self._token.token
                except Exception as e:
                    logger.warning(
                        "token_refresh_failed",
                        error=str(e),
                        workspace=self.workspace
                    )
                    # Fall through to get new token
            
            # Get new token
            await self._authenticate()
            return self._token.token
    
    async def _authenticate(self) -> None:
        """
        Authenticate with gateway and obtain JWT token.
        
        Raises:
            GatewayAuthenticationError: If authentication fails
        """
        try:
            # Get gateway credentials from config
            gateway_token_ref = f"gateway_token_{self.workspace}"
            
            try:
                auth_token = self.config_manager.get_secret(
                    gateway_token_ref,
                    self.workspace
                )
            except Exception as e:
                raise GatewayAuthenticationError(
                    f"Gateway authentication token not found: {gateway_token_ref}"
                ) from e
            
            # Authenticate with gateway
            client = await self._get_client()
            
            response = await client.post(
                f"{self.gateway_url}/auth/token",
                json={"token": auth_token, "workspace": self.workspace},
                timeout=10.0
            )
            
            if response.status_code == 401:
                raise GatewayAuthenticationError(
                    "Gateway authentication failed: Invalid credentials"
                )
            
            if response.status_code != 200:
                raise GatewayAuthenticationError(
                    f"Gateway authentication failed: {response.status_code}"
                )
            
            data = response.json()
            
            # Parse token and expiration
            self._token = JWTToken(
                token=data["access_token"],
                expires_at=datetime.fromisoformat(data["expires_at"]),
                refresh_token=data.get("refresh_token")
            )
            
            logger.info(
                "gateway_authenticated",
                workspace=self.workspace,
                expires_at=self._token.expires_at
            )
            
        except GatewayAuthenticationError:
            raise
        except Exception as e:
            logger.error(
                "gateway_authentication_error",
                error=str(e),
                workspace=self.workspace
            )
            raise GatewayAuthenticationError(
                f"Gateway authentication failed: {e}"
            ) from e
    
    async def _refresh_token(self) -> None:
        """
        Refresh JWT token using refresh token.
        
        Raises:
            GatewayAuthenticationError: If refresh fails
        """
        if self._token is None or self._token.refresh_token is None:
            raise GatewayAuthenticationError("No refresh token available")
        
        try:
            client = await self._get_client()
            
            response = await client.post(
                f"{self.gateway_url}/auth/refresh",
                json={"refresh_token": self._token.refresh_token},
                timeout=10.0
            )
            
            if response.status_code != 200:
                raise GatewayAuthenticationError(
                    f"Token refresh failed: {response.status_code}"
                )
            
            data = response.json()
            
            self._token = JWTToken(
                token=data["access_token"],
                expires_at=datetime.fromisoformat(data["expires_at"]),
                refresh_token=data.get("refresh_token", self._token.refresh_token)
            )
            
            logger.info(
                "gateway_token_refreshed",
                workspace=self.workspace,
                expires_at=self._token.expires_at
            )
            
        except GatewayAuthenticationError:
            raise
        except Exception as e:
            logger.error(
                "gateway_token_refresh_error",
                error=str(e),
                workspace=self.workspace
            )
            raise GatewayAuthenticationError(
                f"Token refresh failed: {e}"
            ) from e
    
    async def call_provider(
        self,
        provider: str,
        request: ProviderRequest
    ) -> ProviderResponse:
        """
        Proxies API call through gateway.
        
        Args:
            provider: Provider name
            request: Provider request
            
        Returns:
            Provider response
            
        Raises:
            GatewayUnavailableError: If gateway is unavailable
            GatewayAuthenticationError: If authentication fails
            GatewayAuthorizationError: If request is denied after authentication
            GatewayQuotaExceededError: If quota is exceeded
            GatewayTimeoutError: If request times out
            GatewayConnectionError: If connection fails
        """
        try:
            # Get valid token
            token = await self._get_token()
            
            # Check quota before making request
            await self._check_quota()
            
            # Make request through gateway
            start_time = time.time()
            
            client = await self._get_client()
            url = f"{self.gateway_url}/providers/{provider}/{request.endpoint.lstrip('/')}"
            
            headers = {
                "Authorization": f"Bearer {token}",
                **request.headers
            }
            if request.resource:
                headers["X-Caracal-Provider-Resource"] = request.resource
            if request.action:
                headers["X-Caracal-Provider-Action"] = request.action
            
            # Make request based on method
            try:
                if request.method.upper() == "GET":
                    response = await client.get(
                        url,
                        params=request.params,
                        headers=headers,
                        timeout=30.0
                    )
                elif request.method.upper() == "POST":
                    response = await client.post(
                        url,
                        params=request.params,
                        json=request.body,
                        headers=headers,
                        timeout=30.0
                    )
                else:
                    raise GatewayConnectionError(
                        f"Unsupported HTTP method: {request.method}"
                    )
            except httpx.TimeoutException as e:
                logger.error(
                    "gateway_call_timeout",
                    provider=provider,
                    endpoint=request.endpoint
                )
                raise GatewayTimeoutError(
                    f"Gateway request timed out: {e}"
                ) from e
            except (httpx.ConnectError, httpx.NetworkError, httpx.HTTPError) as e:
                logger.error(
                    "gateway_connection_error",
                    provider=provider,
                    endpoint=request.endpoint,
                    error=str(e)
                )
                await self._queue_request(request, RequestPriority.NORMAL)
                raise GatewayUnavailableError(
                    f"Gateway unavailable, request queued: {e}"
                ) from e
            except Exception as e:
                logger.error(
                    "gateway_connection_error",
                    provider=provider,
                    endpoint=request.endpoint,
                    error=str(e)
                )
                await self._queue_request(request, RequestPriority.NORMAL)
                raise GatewayUnavailableError(
                    f"Gateway unavailable, request queued: {e}"
                ) from e
            
            latency_ms = (time.time() - start_time) * 1000
            
            # Handle response
            if response.status_code == 401:
                raise GatewayAuthenticationError(
                    "Gateway authentication failed during request"
                )

            if response.status_code == 403:
                reason_code, reason_message = self._extract_gateway_denial(response)
                raise GatewayAuthorizationError(
                    f"Gateway authorization denied ({reason_code}): {reason_message}"
                )
            
            if response.status_code == 429:
                raise GatewayQuotaExceededError(
                    "Gateway quota exceeded"
                )
            
            if response.status_code >= 500:
                raise GatewayUnavailableError(
                    f"Gateway server error: {response.status_code}"
                )
            
            # Update quota from response headers
            self._update_quota_from_headers(response.headers)
            
            logger.info(
                "gateway_call_success",
                provider=provider,
                method=request.method,
                endpoint=request.endpoint,
                status_code=response.status_code,
                latency_ms=latency_ms
            )
            
            return ProviderResponse(
                status_code=response.status_code,
                data=response.json() if response.content else {},
                error=None,
                latency_ms=latency_ms
            )
            
        except (GatewayAuthenticationError, GatewayAuthorizationError, GatewayQuotaExceededError, GatewayUnavailableError):
            raise
        
        except httpx.TimeoutException as e:
            logger.error(
                "gateway_call_timeout",
                provider=provider,
                endpoint=request.endpoint
            )
            raise GatewayTimeoutError(
                f"Gateway request timed out: {e}"
            ) from e
        
        except (httpx.ConnectError, httpx.NetworkError, httpx.HTTPError) as e:
            logger.error(
                "gateway_connection_error",
                provider=provider,
                endpoint=request.endpoint,
                error=str(e)
            )
            
            # Queue request for later
            await self._queue_request(request, RequestPriority.NORMAL)
            
            raise GatewayUnavailableError(
                f"Gateway unavailable, request queued: {e}"
            ) from e
        
        except Exception as e:
            logger.error(
                "gateway_call_error",
                provider=provider,
                endpoint=request.endpoint,
                error=str(e)
            )
            raise GatewayConnectionError(
                f"Gateway call failed: {e}"
            ) from e
    
    async def stream_provider_call(
        self,
        provider: str,
        request: ProviderRequest
    ) -> AsyncIterator[ProviderResponse]:
        """
        Streams provider response for long-running operations.
        
        Args:
            provider: Provider name
            request: Provider request
            
        Yields:
            Provider response chunks
            
        Raises:
            GatewayUnavailableError: If gateway is unavailable
            GatewayAuthenticationError: If authentication fails
            GatewayAuthorizationError: If request is denied after authentication
            GatewayTimeoutError: If request times out
        """
        try:
            # Get valid token
            token = await self._get_token()
            
            # Check quota
            await self._check_quota()
            
            # Make streaming request
            client = await self._get_client()
            url = f"{self.gateway_url}/providers/{provider}/{request.endpoint.lstrip('/')}"
            
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream",
                **request.headers
            }
            if request.resource:
                headers["X-Caracal-Provider-Resource"] = request.resource
            if request.action:
                headers["X-Caracal-Provider-Action"] = request.action
            
            stream_context = client.stream(
                request.method.upper(),
                url,
                params=request.params,
                json=request.body if request.method.upper() == "POST" else None,
                headers=headers,
                timeout=None  # No timeout for streaming
            )
            if asyncio.iscoroutine(stream_context):
                stream_context = await stream_context

            async with stream_context as response:
                if response.status_code == 401:
                    raise GatewayAuthenticationError(
                        "Gateway authentication failed during streaming"
                    )

                if response.status_code == 403:
                    reason_code, reason_message = self._extract_gateway_denial(response)
                    raise GatewayAuthorizationError(
                        f"Gateway authorization denied ({reason_code}): {reason_message}"
                    )
                
                if response.status_code == 429:
                    raise GatewayQuotaExceededError(
                        "Gateway quota exceeded"
                    )
                
                if response.status_code >= 500:
                    raise GatewayUnavailableError(
                        f"Gateway server error: {response.status_code}"
                    )
                
                # Stream response chunks
                async for chunk in response.aiter_text():
                    if chunk.strip():
                        yield ProviderResponse(
                            status_code=response.status_code,
                            data={"chunk": chunk},
                            error=None,
                            latency_ms=0.0
                        )
                
                # Update quota from response headers
                self._update_quota_from_headers(response.headers)
                
                logger.info(
                    "gateway_stream_complete",
                    provider=provider,
                    endpoint=request.endpoint
                )
        
        except (GatewayAuthenticationError, GatewayAuthorizationError, GatewayQuotaExceededError):
            raise
        
        except httpx.TimeoutException as e:
            logger.error(
                "gateway_stream_timeout",
                provider=provider,
                endpoint=request.endpoint
            )
            raise GatewayTimeoutError(
                f"Gateway streaming timed out: {e}"
            ) from e
        
        except (httpx.ConnectError, httpx.NetworkError, httpx.HTTPError) as e:
            logger.error(
                "gateway_stream_error",
                provider=provider,
                endpoint=request.endpoint,
                error=str(e)
            )
            raise GatewayConnectionError(
                f"Gateway streaming failed: {e}"
            ) from e
        
        except Exception as e:
            logger.error(
                "gateway_stream_error",
                provider=provider,
                endpoint=request.endpoint,
                error=str(e)
            )
            raise GatewayConnectionError(
                f"Gateway streaming failed: {e}"
            ) from e
    
    async def get_available_providers(self) -> List[ProviderInfo]:
        """
        Returns providers configured in gateway.
        
        Returns:
            List of provider information
            
        Raises:
            GatewayConnectionError: If request fails
        """
        try:
            token = await self._get_token()
            
            client = await self._get_client()
            response = await client.get(
                f"{self.gateway_url}/providers",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10.0
            )
            
            if response.status_code != 200:
                raise GatewayConnectionError(
                    f"Failed to get providers: {response.status_code}"
                )
            
            data = response.json()
            
            providers = [
                ProviderInfo(
                    name=p.get("name") or p.get("provider_id", "unknown"),
                    provider_type=p.get("service_type") or p.get("type", "api"),
                    available=p.get("available", p.get("enabled", True)),
                    quota_remaining=p.get("quota_remaining"),
                    auth_scheme=p.get("auth_scheme"),
                    version=p.get("version"),
                    tags=p.get("tags", []),
                    metadata=p.get("metadata", {}),
                    provider_definition=p.get("provider_definition"),
                    resources=p.get("resources", []) or [],
                    actions=p.get("actions", []) or [],
                )
                for p in data["providers"]
            ]
            
            logger.info(
                "gateway_providers_retrieved",
                count=len(providers)
            )
            
            return providers
            
        except Exception as e:
            logger.error(
                "gateway_get_providers_error",
                error=str(e)
            )
            raise GatewayConnectionError(
                f"Failed to get providers: {e}"
            ) from e
    
    async def check_connection(self) -> GatewayHealthCheck:
        """
        Verifies gateway connectivity and authentication.
        
        Returns:
            Health check result
        """
        try:
            start_time = time.time()
            
            # Try to get token (will authenticate if needed)
            token = await self._get_token()
            
            # Make health check request
            client = await self._get_client()
            response = await client.get(
                f"{self.gateway_url}/health",
                headers={"Authorization": f"Bearer {token}"},
                timeout=5.0
            )
            
            latency_ms = (time.time() - start_time) * 1000
            
            healthy = response.status_code == 200
            authenticated = response.status_code != 401
            
            logger.info(
                "gateway_health_check",
                healthy=healthy,
                authenticated=authenticated,
                latency_ms=latency_ms
            )
            
            return GatewayHealthCheck(
                healthy=healthy,
                latency_ms=latency_ms,
                authenticated=authenticated,
                error=None if healthy else f"Status code: {response.status_code}"
            )
            
        except Exception as e:
            logger.warning(
                "gateway_health_check_failed",
                error=str(e)
            )
            
            return GatewayHealthCheck(
                healthy=False,
                latency_ms=0.0,
                authenticated=False,
                error=str(e)
            )
    
    async def get_quota_status(self) -> QuotaStatus:
        """
        Returns current quota usage and limits.
        
        Returns:
            Quota status
            
        Raises:
            GatewayConnectionError: If request fails
        """
        try:
            token = await self._get_token()
            
            client = await self._get_client()
            response = await client.get(
                f"{self.gateway_url}/quota",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10.0
            )
            
            if response.status_code != 200:
                raise GatewayConnectionError(
                    f"Failed to get quota: {response.status_code}"
                )
            
            data = response.json()
            
            quota = QuotaStatus(
                total_quota=data["total"],
                used_quota=data["used"],
                remaining_quota=data["remaining"],
                reset_at=datetime.fromisoformat(data["reset_at"]),
                percentage_used=(data["used"] / data["total"] * 100) if data["total"] > 0 else 0.0
            )
            
            self._quota_status = quota
            self._last_quota_check = datetime.now()
            
            logger.info(
                "gateway_quota_retrieved",
                remaining=quota.remaining_quota,
                percentage_used=quota.percentage_used
            )
            
            return quota
            
        except Exception as e:
            logger.error(
                "gateway_get_quota_error",
                error=str(e)
            )
            raise GatewayConnectionError(
                f"Failed to get quota: {e}"
            ) from e
    
    async def _check_quota(self) -> None:
        """
        Check quota before making request.
        
        Raises:
            GatewayQuotaExceededError: If quota is exceeded
        """
        # Check cached quota if available and recent
        if self._quota_status is not None and self._last_quota_check is not None:
            elapsed = (datetime.now() - self._last_quota_check).total_seconds()
            if elapsed < 60:  # Cache for 1 minute
                if self._quota_status.remaining_quota <= 0:
                    raise GatewayQuotaExceededError(
                        f"Gateway quota exceeded. Resets at {self._quota_status.reset_at}"
                    )
                return
        
        # Fetch fresh quota status
        try:
            quota = await self.get_quota_status()
            if quota.remaining_quota <= 0:
                raise GatewayQuotaExceededError(
                    f"Gateway quota exceeded. Resets at {quota.reset_at}"
                )
        except GatewayConnectionError:
            # If we can't check quota, allow the request to proceed
            logger.warning("quota_check_failed_allowing_request")
    
    def _update_quota_from_headers(self, headers: httpx.Headers) -> None:
        """Update quota status from response headers."""
        try:
            if "X-Quota-Remaining" in headers:
                remaining = int(headers["X-Quota-Remaining"])
                total = int(headers.get("X-Quota-Total", 0))
                used = total - remaining
                
                if "X-Quota-Reset" in headers:
                    reset_at = datetime.fromisoformat(headers["X-Quota-Reset"])
                else:
                    reset_at = datetime.now() + timedelta(hours=1)
                
                self._quota_status = QuotaStatus(
                    total_quota=total,
                    used_quota=used,
                    remaining_quota=remaining,
                    reset_at=reset_at,
                    percentage_used=(used / total * 100) if total > 0 else 0.0
                )
                self._last_quota_check = datetime.now()
        except Exception as e:
            logger.debug("failed_to_parse_quota_headers", error=str(e))

    @staticmethod
    def _extract_gateway_denial(response: httpx.Response) -> tuple[str, str]:
        """Extract deny reason code/message from gateway response payload."""
        default_code = "BOUNDARY_2_OR_3_DENY"
        default_message = f"HTTP {response.status_code}"
        try:
            payload = response.json()
        except Exception:
            return default_code, default_message

        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                reason_code = str(error.get("code") or default_code)
                reason_message = str(error.get("message") or default_message)
                return reason_code, reason_message
            if isinstance(error, str):
                return default_code, error
            if isinstance(payload.get("message"), str):
                return default_code, payload["message"]

        return default_code, default_message
    
    async def _queue_request(
        self,
        request: ProviderRequest,
        priority: RequestPriority,
        ttl_seconds: Optional[int] = None
    ) -> None:
        """
        Queue request for later execution when gateway unavailable.
        
        Args:
            request: Provider request
            priority: Request priority
            ttl_seconds: Time to live for request
        """
        async with self._queue_lock:
            # Remove expired requests
            self._cleanup_expired_requests()
            
            # Check queue size
            if len(self._request_queue) >= self.max_queue_size:
                logger.warning(
                    "request_queue_full",
                    max_size=self.max_queue_size
                )
                # Remove lowest priority request
                self._remove_lowest_priority_request()
            
            # Add request to queue
            queued_request = QueuedRequest(
                request=request,
                priority=priority,
                queued_at=datetime.now(),
                ttl_seconds=ttl_seconds or self.default_ttl_seconds
            )
            
            self._request_queue.append(queued_request)
            
            logger.info(
                "request_queued",
                provider=request.provider,
                endpoint=request.endpoint,
                priority=priority,
                queue_size=len(self._request_queue)
            )
    
    def _cleanup_expired_requests(self) -> None:
        """Remove expired requests from queue."""
        original_size = len(self._request_queue)
        
        # Filter out expired requests
        self._request_queue = deque(
            (req for req in self._request_queue if not req.is_expired()),
            maxlen=self.max_queue_size
        )
        
        removed = original_size - len(self._request_queue)
        if removed > 0:
            logger.info("expired_requests_removed", count=removed)
    
    def _remove_lowest_priority_request(self) -> None:
        """Remove lowest priority request from queue."""
        if not self._request_queue:
            return
        
        # Priority order: LOW < NORMAL < HIGH < CRITICAL
        priority_order = {
            RequestPriority.LOW: 0,
            RequestPriority.NORMAL: 1,
            RequestPriority.HIGH: 2,
            RequestPriority.CRITICAL: 3
        }
        
        # Find lowest priority request
        min_priority = min(
            self._request_queue,
            key=lambda req: priority_order[req.priority]
        )
        
        self._request_queue.remove(min_priority)
        
        logger.info(
            "lowest_priority_request_removed",
            priority=min_priority.priority
        )
    
    async def process_queued_requests(self) -> int:
        """
        Process queued requests when gateway becomes available.
        
        Returns:
            Number of requests processed successfully
        """
        async with self._queue_lock:
            if not self._request_queue:
                return 0
            
            # Clean up expired requests first
            self._cleanup_expired_requests()
            
            processed = 0
            failed = 0
            
            # Process requests in priority order
            requests_to_process = sorted(
                self._request_queue,
                key=lambda req: (
                    {"low": 0, "normal": 1, "high": 2, "critical": 3}[req.priority],
                    req.queued_at
                ),
                reverse=True
            )
            
            for queued_request in requests_to_process:
                try:
                    await self.call_provider(
                        queued_request.request.provider,
                        queued_request.request
                    )
                    
                    self._request_queue.remove(queued_request)
                    processed += 1
                    
                except Exception as e:
                    logger.warning(
                        "queued_request_failed",
                        provider=queued_request.request.provider,
                        error=str(e),
                        retry_count=queued_request.retry_count
                    )
                    
                    queued_request.retry_count += 1
                    
                    # Remove if max retries exceeded
                    if queued_request.retry_count >= 3:
                        self._request_queue.remove(queued_request)
                        failed += 1
            
            logger.info(
                "queued_requests_processed",
                processed=processed,
                failed=failed,
                remaining=len(self._request_queue)
            )
            
            return processed
    
    def get_queue_size(self) -> int:
        """Get current queue size."""
        return len(self._request_queue)
    
    def clear_queue(self) -> None:
        """Clear all queued requests."""
        self._request_queue.clear()
        logger.info("request_queue_cleared")
