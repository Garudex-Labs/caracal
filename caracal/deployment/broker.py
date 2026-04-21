"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Broker for Open-Source Edition.

Handles direct communication with external providers with circuit breaker,
rate limiting, retry logic, and health checks.
"""

import asyncio
import random
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

import httpx
import structlog

from caracal.deployment.config_manager import ConfigManager
from caracal.deployment.exceptions import (
    CircuitBreakerOpenError,
    ProviderAuthenticationError,
    ProviderAuthorizationError,
    ProviderConfigurationError,
    ProviderConnectionError,
    ProviderNotFoundError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    SecretNotFoundError,
)
from caracal.provider.credential_store import resolve_workspace_provider_credential
from caracal.provider.definitions import (
    ProviderDefinition,
    ScopeParseError,
    provider_definition_from_mapping,
    parse_provider_scope,
    resolve_provider_definition_id,
)
from caracal.provider.catalog import (
    GATEWAY_ONLY_AUTH,
    ProviderCatalogError,
    resolve_auth_headers,
)

logger = structlog.get_logger(__name__)


class CircuitState(str, Enum):
    """Circuit breaker state enumeration."""
    CLOSED = "closed"  # Normal operation
    OPEN = "open"  # Failures exceeded threshold, fail fast
    HALF_OPEN = "half_open"  # Testing if service recovered


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


@dataclass
class ProviderResponse:
    """Provider response data model."""
    status_code: int
    data: Dict[str, Any]
    error: Optional[str] = None
    latency_ms: float = 0.0


@dataclass
class ProviderConfig:
    """Provider configuration data model."""
    name: str
    provider_type: str
    provider_definition: Optional[str] = None
    definition: Optional[Dict[str, Any]] = None
    auth_scheme: str = "api_key"
    credential_ref: Optional[str] = None
    base_url: Optional[str] = None
    timeout_seconds: int = 30
    max_retries: int = 3
    rate_limit_rpm: Optional[int] = None  # Requests per minute
    healthcheck_path: str = "/health"
    default_headers: Dict[str, str] = field(default_factory=dict)
    auth_metadata: Dict[str, Any] = field(default_factory=dict)
    version: Optional[str] = None
    capabilities: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    access_policy: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    enforce_scoped_requests: bool = False

    def __post_init__(self) -> None:
        self.provider_definition = resolve_provider_definition_id(
            service_type=self.provider_type,
            requested_definition=self.provider_definition,
        )

    @property
    def service_type(self) -> str:
        """Alias for provider_type to support service-agnostic terminology."""
        return self.provider_type


@dataclass
class RateLimit:
    """Token bucket rate limiter."""
    requests_per_minute: int
    tokens: float = 0.0
    last_refill: datetime = field(default_factory=datetime.now)
    
    def consume(self, tokens: int = 1) -> bool:
        """
        Attempt to consume tokens from the bucket.
        
        Args:
            tokens: Number of tokens to consume
            
        Returns:
            True if tokens were consumed, False if rate limit exceeded
        """
        self._refill()
        
        if self.tokens >= tokens:
            self.tokens -= tokens
            return True
        
        return False
    
    def _refill(self) -> None:
        """Refill tokens based on elapsed time."""
        now = datetime.now()
        elapsed = (now - self.last_refill).total_seconds()
        if elapsed <= 0:
            return
        
        # Refill rate: requests_per_minute / 60 = requests per second
        refill_rate = self.requests_per_minute / 60.0
        tokens_to_add = elapsed * refill_rate
        
        self.tokens = min(self.tokens + tokens_to_add, self.requests_per_minute)
        # Avoid tiny floating-point drift for immediate consecutive calls.
        nearest_int = round(self.tokens)
        if abs(self.tokens - nearest_int) < 1e-3:
            self.tokens = float(nearest_int)
        self.last_refill = now


@dataclass
class CircuitBreaker:
    """Circuit breaker for provider fault tolerance."""
    failure_threshold: int = 5
    timeout_seconds: int = 30
    half_open_max_calls: int = 1
    
    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    success_count: int = 0
    opened_at: Optional[datetime] = None
    half_open_calls: int = 0
    
    def call(self, func):
        """
        Execute function with circuit breaker protection.
        
        Args:
            func: Function to execute
            
        Returns:
            Function result
            
        Raises:
            CircuitBreakerOpenError: If circuit is open
        """
        if self.state == CircuitState.OPEN:
            if self._should_attempt_reset():
                self.state = CircuitState.HALF_OPEN
                self.half_open_calls = 0
                logger.info("circuit_breaker_half_open")
            else:
                raise CircuitBreakerOpenError(
                    f"Circuit breaker is open. Opened at {self.opened_at}"
                )
        
        if self.state == CircuitState.HALF_OPEN:
            if self.half_open_calls >= self.half_open_max_calls:
                raise CircuitBreakerOpenError(
                    "Circuit breaker half-open call limit reached"
                )
            self.half_open_calls += 1
        
        try:
            result = func()
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise

    async def call_async(self, func):
        """
        Execute async function with circuit breaker protection.

        Args:
            func: Async function to execute

        Returns:
            Function result

        Raises:
            CircuitBreakerOpenError: If circuit is open
        """
        if self.state == CircuitState.OPEN:
            if self._should_attempt_reset():
                self.state = CircuitState.HALF_OPEN
                self.half_open_calls = 0
                logger.info("circuit_breaker_half_open")
            else:
                raise CircuitBreakerOpenError(
                    f"Circuit breaker is open. Opened at {self.opened_at}"
                )

        if self.state == CircuitState.HALF_OPEN:
            if self.half_open_calls >= self.half_open_max_calls:
                raise CircuitBreakerOpenError(
                    "Circuit breaker half-open call limit reached"
                )
            self.half_open_calls += 1

        try:
            result = await func()
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise
    
    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt reset."""
        if self.opened_at is None:
            return False
        
        elapsed = (datetime.now() - self.opened_at).total_seconds()
        return elapsed >= self.timeout_seconds
    
    def _on_success(self) -> None:
        """Handle successful call."""
        if self.state == CircuitState.HALF_OPEN:
            self.success_count += 1
            if self.success_count >= self.half_open_max_calls:
                self.state = CircuitState.CLOSED
                self.failure_count = 0
                self.success_count = 0
                logger.info("circuit_breaker_closed")
        else:
            self.failure_count = 0
    
    def _on_failure(self) -> None:
        """Handle failed call."""
        self.failure_count += 1
        
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.OPEN
            self.opened_at = datetime.now()
            logger.warning("circuit_breaker_reopened")
        elif self.failure_count >= self.failure_threshold:
            self.state = CircuitState.OPEN
            self.opened_at = datetime.now()
            logger.warning(
                "circuit_breaker_opened",
                failure_count=self.failure_count,
                threshold=self.failure_threshold
            )


@dataclass
class ProviderInfo:
    """Provider information for listing."""
    name: str
    provider_type: str
    base_url: Optional[str]
    configured: bool
    circuit_state: CircuitState
    auth_scheme: str = "api_key"
    version: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    status: str = "configured"
    last_error: Optional[str] = None
    provider_definition: Optional[str] = None
    scoped_authorization: bool = False

    @property
    def service_type(self) -> str:
        """Alias for provider_type to support service-agnostic terminology."""
        return self.provider_type


@dataclass
class ProviderHealthCheck:
    """Provider health check result."""
    provider: str
    healthy: bool
    latency_ms: float
    reachable: bool = False
    status_code: Optional[int] = None
    auth_injected: bool = False
    error: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class ProviderMetrics:
    """Provider usage metrics."""
    provider: str
    total_requests: int
    successful_requests: int
    failed_requests: int
    average_latency_ms: float
    circuit_state: CircuitState
    rate_limit_hits: int


class Broker:
    """
    Broker for Open-Source Edition.
    
    Handles direct communication with external dependencies with:
    - Circuit breaker pattern per provider
    - Token bucket rate limiting
    - Retry logic with exponential backoff
    - Provider health checks
    - Metrics collection
    """
    
    def __init__(self, config_manager: Optional[ConfigManager] = None, workspace: str = "default"):
        """
        Initialize the broker.
        
        Args:
            config_manager: Configuration manager instance
            workspace: Workspace name for retrieving API keys
        """
        self.config_manager = config_manager or ConfigManager()
        self.workspace = workspace
        
        # Provider configurations
        self._providers: Dict[str, ProviderConfig] = {}
        
        # Circuit breakers per provider
        self._circuit_breakers: Dict[str, CircuitBreaker] = defaultdict(CircuitBreaker)
        
        # Rate limiters per provider
        self._rate_limiters: Dict[str, RateLimit] = {}
        
        # Metrics per provider
        self._metrics: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {
                "total_requests": 0,
                "successful_requests": 0,
                "failed_requests": 0,
                "total_latency_ms": 0.0,
                "rate_limit_hits": 0,
            }
        )
        
        # HTTP client
        self._client: Optional[httpx.AsyncClient] = None
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create async HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                limits=httpx.Limits(max_keepalive_connections=10, max_connections=20)
            )
        return self._client
    
    async def close(self) -> None:
        """Close HTTP client and cleanup resources."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
    
    def configure_provider(self, provider: str, config: ProviderConfig) -> None:
        """
        Configures provider credentials and settings.
        
        Args:
            provider: Provider name
            config: Provider configuration
            
        Raises:
            ProviderConfigurationError: If configuration is invalid
        """
        try:
            # Validate configuration
            if not config.name:
                raise ProviderConfigurationError("Provider name is required")
            
            if not config.provider_type:
                raise ProviderConfigurationError("Provider type is required")
            
            normalized_auth_scheme = config.auth_scheme.replace("-", "_").lower()
            supported_auth_schemes = {
                "none",
                "api_key",
                "bearer",
                "basic",
                "header",
                "oauth2_client_credentials",
                "service_account",
            }
            if normalized_auth_scheme not in supported_auth_schemes:
                raise ProviderConfigurationError(
                    f"Unsupported auth scheme: {config.auth_scheme}"
                )
            if normalized_auth_scheme in GATEWAY_ONLY_AUTH:
                raise ProviderConfigurationError(
                    f"Auth scheme '{config.auth_scheme}' requires enterprise gateway execution."
                )

            if normalized_auth_scheme not in {"none"} and not config.credential_ref:
                raise ProviderConfigurationError(
                    "Credential reference is required for authenticated providers"
                )
            
            # Store configuration
            self._providers[provider] = config
            
            # Initialize rate limiter if configured
            if config.rate_limit_rpm:
                self._rate_limiters[provider] = RateLimit(
                    requests_per_minute=config.rate_limit_rpm
                )
            
            logger.info(
                "provider_configured",
                provider=provider,
                provider_type=config.provider_type,
                auth_scheme=normalized_auth_scheme,
                rate_limit_rpm=config.rate_limit_rpm
            )
            
        except Exception as e:
            logger.error(
                "provider_configuration_failed",
                provider=provider,
                error=str(e)
            )
            raise ProviderConfigurationError(
                f"Failed to configure provider {provider}: {e}"
            ) from e
    
    def list_providers(self) -> List[ProviderInfo]:
        """
        Returns list of configured providers with status.
        
        Returns:
            List of provider information
        """
        providers = []
        
        for name, config in self._providers.items():
            circuit_breaker = self._circuit_breakers[name]
            
            providers.append(ProviderInfo(
                name=name,
                provider_type=config.provider_type,
                base_url=config.base_url,
                configured=True,
                circuit_state=circuit_breaker.state,
                auth_scheme=config.auth_scheme,
                version=config.version,
                tags=config.tags,
                status=self._status_from_circuit_state(circuit_breaker.state),
                last_error=None,  # Could track this in metrics
                provider_definition=config.provider_definition,
                scoped_authorization=config.enforce_scoped_requests,
            ))
        
        return providers
    
    async def test_provider(self, provider: str) -> ProviderHealthCheck:
        """
        Tests provider connectivity and credentials.
        
        Args:
            provider: Provider name
            
        Returns:
            Health check result
            
        Raises:
            ProviderNotFoundError: If provider not configured
        """
        if provider not in self._providers:
            raise ProviderNotFoundError(f"Provider not configured: {provider}")
        
        config = self._providers[provider]
        
        try:
            # Simple health check: make a minimal request
            start_time = time.time()
            
            auth_headers = self._build_auth_headers(provider, config)
            
            # Make test request (provider-specific endpoint)
            client = await self._get_client()
            base_url = config.base_url or self._get_default_base_url(config.provider_type)
            
            response = await client.get(
                f"{base_url}/{config.healthcheck_path.lstrip('/')}",
                headers={**config.default_headers, **auth_headers},
                timeout=5.0
            )
            
            latency_ms = (time.time() - start_time) * 1000
            
            healthy = response.status_code == 200
            
            logger.info(
                "provider_health_check",
                provider=provider,
                healthy=healthy,
                latency_ms=latency_ms,
                status_code=response.status_code
            )
            
            return ProviderHealthCheck(
                provider=provider,
                healthy=healthy,
                latency_ms=latency_ms,
                reachable=True,
                status_code=response.status_code,
                auth_injected=bool(auth_headers),
                error=None if healthy else f"Status code: {response.status_code}"
            )
            
        except Exception as e:
            logger.warning(
                "provider_health_check_failed",
                provider=provider,
                error=str(e)
            )
            
            return ProviderHealthCheck(
                provider=provider,
                healthy=False,
                latency_ms=0.0,
                reachable=False,
                status_code=None,
                auth_injected=False,
                error=str(e)
            )
    
    def get_provider_metrics(self, provider: str) -> ProviderMetrics:
        """
        Returns usage metrics for provider.
        
        Args:
            provider: Provider name
            
        Returns:
            Provider metrics
            
        Raises:
            ProviderNotFoundError: If provider not configured
        """
        if provider not in self._providers:
            raise ProviderNotFoundError(f"Provider not configured: {provider}")
        
        metrics = self._metrics[provider]
        circuit_breaker = self._circuit_breakers[provider]
        
        avg_latency = 0.0
        if metrics["successful_requests"] > 0:
            avg_latency = metrics["total_latency_ms"] / metrics["successful_requests"]
        
        return ProviderMetrics(
            provider=provider,
            total_requests=metrics["total_requests"],
            successful_requests=metrics["successful_requests"],
            failed_requests=metrics["failed_requests"],
            average_latency_ms=avg_latency,
            circuit_state=circuit_breaker.state,
            rate_limit_hits=metrics["rate_limit_hits"]
        )
    
    async def call_provider(self, provider: str, request: ProviderRequest) -> ProviderResponse:
        """
        Makes direct API call to provider with retry logic.
        
        Implements:
        - Circuit breaker pattern
        - Rate limiting
        - Exponential backoff retry
        - Metrics collection
        
        Args:
            provider: Provider name
            request: Provider request
            
        Returns:
            Provider response
            
        Raises:
            ProviderNotFoundError: If provider not configured
            CircuitBreakerOpenError: If circuit breaker is open
            ProviderRateLimitError: If rate limit exceeded
            ProviderConnectionError: If connection fails
            ProviderTimeoutError: If request times out
            ProviderAuthenticationError: If authentication fails
        """
        if provider not in self._providers:
            raise ProviderNotFoundError(f"Provider not configured: {provider}")
        
        config = self._providers[provider]
        circuit_breaker = self._circuit_breakers[provider]
        self._validate_request_scope(provider, config, request)
        
        # Check rate limit
        if provider in self._rate_limiters:
            rate_limiter = self._rate_limiters[provider]
            if not rate_limiter.consume():
                self._metrics[provider]["rate_limit_hits"] += 1
                logger.warning(
                    "provider_rate_limit_exceeded",
                    provider=provider,
                    rpm=rate_limiter.requests_per_minute
                )
                raise ProviderRateLimitError(
                    f"Rate limit exceeded for provider {provider}"
                )
        
        # Execute with circuit breaker
        async def make_request():
            return await self._call_provider_with_retry(provider, config, request)

        try:
            response = await circuit_breaker.call_async(make_request)
            return response
        except CircuitBreakerOpenError:
            logger.error(
                "provider_circuit_breaker_open",
                provider=provider,
                state=circuit_breaker.state
            )
            raise
    
    async def _call_provider_with_retry(
        self,
        provider: str,
        config: ProviderConfig,
        request: ProviderRequest
    ) -> ProviderResponse:
        """
        Make provider API call with exponential backoff retry.
        
        Args:
            provider: Provider name
            config: Provider configuration
            request: Provider request
            
        Returns:
            Provider response
            
        Raises:
            ProviderConnectionError: If all retries fail
            ProviderTimeoutError: If request times out
            ProviderAuthenticationError: If authentication fails
            ProviderAuthorizationError: If provider denies an authorized request
        """
        self._metrics[provider]["total_requests"] += 1
        
        last_error = None
        
        for attempt in range(config.max_retries):
            try:
                start_time = time.time()
                
                # Get API key
                auth_headers = self._build_auth_headers(provider, config)
                
                # Build request
                client = await self._get_client()
                base_url = config.base_url
                if not base_url and config.provider_definition:
                    try:
                        definition = self._get_definition_for_provider(provider, config)
                        base_url = definition.default_base_url
                    except Exception:
                        base_url = None
                if not base_url:
                    base_url = self._get_default_base_url(config.provider_type)
                url = f"{base_url}/{request.endpoint.lstrip('/')}"
                
                headers = {
                    **config.default_headers,
                    **auth_headers,
                    **request.headers
                }
                
                # Make request
                if request.method.upper() == "GET":
                    response = await client.get(
                        url,
                        params=request.params,
                        headers=headers,
                        timeout=config.timeout_seconds
                    )
                elif request.method.upper() == "POST":
                    response = await client.post(
                        url,
                        params=request.params,
                        json=request.body,
                        headers=headers,
                        timeout=config.timeout_seconds
                    )
                else:
                    raise ProviderConfigurationError(
                        f"Unsupported HTTP method: {request.method}"
                    )
                
                latency_ms = (time.time() - start_time) * 1000
                
                # Handle response
                if response.status_code == 401:
                    raise ProviderAuthenticationError(
                        f"Authentication failed for provider {provider}: {response.status_code}"
                    )

                if response.status_code == 403:
                    raise ProviderAuthorizationError(
                        f"Authorization denied for provider {provider}: {response.status_code}"
                    )
                
                if response.status_code >= 500:
                    # Server error, retry
                    raise ProviderConnectionError(
                        f"Provider server error: {response.status_code}"
                    )
                
                # Success
                self._metrics[provider]["successful_requests"] += 1
                self._metrics[provider]["total_latency_ms"] += latency_ms
                
                logger.info(
                    "provider_call_success",
                    provider=provider,
                    method=request.method,
                    endpoint=request.endpoint,
                    status_code=response.status_code,
                    latency_ms=latency_ms,
                    attempt=attempt + 1
                )
                
                return ProviderResponse(
                    status_code=response.status_code,
                    data=response.json() if response.content else {},
                    error=None,
                    latency_ms=latency_ms
                )
                
            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(
                    "provider_call_timeout",
                    provider=provider,
                    attempt=attempt + 1,
                    max_retries=config.max_retries
                )
                
                if attempt == config.max_retries - 1:
                    self._metrics[provider]["failed_requests"] += 1
                    raise ProviderTimeoutError(
                        f"Provider request timed out after {config.max_retries} attempts"
                    ) from e
                
            except (httpx.ConnectError, httpx.NetworkError) as e:
                last_error = e
                logger.warning(
                    "provider_call_connection_error",
                    provider=provider,
                    attempt=attempt + 1,
                    max_retries=config.max_retries,
                    error=str(e)
                )
                
                if attempt == config.max_retries - 1:
                    self._metrics[provider]["failed_requests"] += 1
                    raise ProviderConnectionError(
                        f"Provider connection failed after {config.max_retries} attempts: {e}"
                    ) from e
            
            except (ProviderAuthenticationError, ProviderAuthorizationError):
                # Don't retry authn/authz denials.
                self._metrics[provider]["failed_requests"] += 1
                raise
            
            except Exception as e:
                last_error = e
                logger.error(
                    "provider_call_unexpected_error",
                    provider=provider,
                    attempt=attempt + 1,
                    error=str(e)
                )
                
                if attempt == config.max_retries - 1:
                    self._metrics[provider]["failed_requests"] += 1
                    raise ProviderConnectionError(
                        f"Provider call failed: {e}"
                    ) from e
            
            # Exponential backoff with jitter
            if attempt < config.max_retries - 1:
                delay = min(2 ** attempt, 16)  # Cap at 16 seconds
                jitter = random.uniform(0, delay * 0.1)  # 10% jitter
                await asyncio.sleep(delay + jitter)
        
        # Should not reach here, but just in case
        self._metrics[provider]["failed_requests"] += 1
        raise ProviderConnectionError(
            f"Provider call failed after {config.max_retries} attempts: {last_error}"
        )
    
    def _get_default_base_url(self, provider_type: str) -> str:
        """
        Get default base URL for provider type.
        
        Args:
            provider_type: Provider type
            
        Returns:
            Default base URL
        """
        defaults = {
            "ai": "https://api.example-ai.com",
            "api": "https://api.example.com/v1",
            "application": "https://api.example.com/v1",
            "database": "https://db.example.com",
            "data": "https://data.example.com",
            "identity": "https://identity.example.com",
            "messaging": "https://messaging.example.com",
            "storage": "https://storage.example.com",
            "payments": "https://payments.example.com",
            "developer-tools": "https://dev.example.com",
            "observability": "https://observability.example.com",
            "infrastructure": "https://infra.example.com",
            "infra": "https://infra.example.com",
            "internal": "https://internal.example.com",
        }

        return defaults.get(provider_type.lower(), "https://api.example.com/v1")

    def _build_auth_headers(self, provider: str, config: ProviderConfig) -> Dict[str, str]:
        """Resolve provider auth scheme into outbound request headers."""
        scheme = config.auth_scheme.replace("-", "_").lower()
        if scheme == "none":
            return {}

        if not config.credential_ref:
            raise ProviderAuthenticationError(
                f"Provider '{provider}' is missing credential_ref"
            )

        try:
            credential_value = resolve_workspace_provider_credential(
                self.workspace,
                config.credential_ref,
            )
        except SecretNotFoundError as e:
            raise ProviderAuthenticationError(
                f"Credential not found for provider {provider}: {config.credential_ref}"
            ) from e

        try:
            return resolve_auth_headers(
                auth_scheme=scheme,
                credential_value=credential_value,
                auth_metadata=config.auth_metadata,
                allow_gateway_managed=False,
            )
        except ProviderCatalogError as exc:
            raise ProviderAuthenticationError(str(exc)) from exc

    def _validate_request_scope(
        self,
        provider: str,
        config: ProviderConfig,
        request: ProviderRequest,
    ) -> None:
        """
        Validate provider-scoped action/resource contract before execution.

        When scoped enforcement is enabled, the broker requires a canonical
        provider resource and action and verifies that HTTP method/path align
        with the provider definition.
        """
        if not request.resource and not request.action and not config.enforce_scoped_requests:
            return

        definition = self._get_definition_for_provider(provider, config)

        resource_id = self._normalize_scope_identifier(
            scope_or_id=request.resource,
            expected_kind="resource",
            provider=provider,
        )
        action_id = self._normalize_scope_identifier(
            scope_or_id=request.action,
            expected_kind="action",
            provider=provider,
        )

        if config.enforce_scoped_requests and (not resource_id or not action_id):
            raise ProviderConfigurationError(
                f"Provider '{provider}' requires provider-scoped resource/action headers for execution"
            )

        if not resource_id and not action_id:
            return

        if resource_id and resource_id not in definition.resources:
            raise ProviderConfigurationError(
                f"Resource '{resource_id}' is not supported by provider definition '{definition.definition_id}'"
            )

        if action_id:
            action = definition.get_action(action_id=action_id, resource_id=resource_id)
            if not action:
                raise ProviderConfigurationError(
                    f"Action '{action_id}' is not supported for provider '{provider}'"
                )

            request_method = request.method.strip().upper()
            if request_method != action.method.upper():
                raise ProviderConfigurationError(
                    f"Action '{action_id}' requires HTTP {action.method}, got {request_method}"
                )

            normalized_endpoint = "/" + request.endpoint.lstrip("/")
            if not normalized_endpoint.startswith(action.path_prefix):
                raise ProviderConfigurationError(
                    f"Action '{action_id}' requires path prefix '{action.path_prefix}', "
                    f"got '{normalized_endpoint}'"
                )

    @staticmethod
    def _get_definition_for_provider(
        provider: str,
        config: ProviderConfig,
    ) -> ProviderDefinition:
        payload = config.definition
        if not isinstance(payload, dict):
            raise ProviderConfigurationError(
                f"Provider '{provider}' is missing structured definition payload"
            )
        return provider_definition_from_mapping(
            payload,
            default_definition_id=config.provider_definition or provider,
            default_service_type=config.provider_type or "api",
            default_display_name=provider,
            default_auth_scheme=config.auth_scheme or "api_key",
            default_base_url=config.base_url,
        )

    @staticmethod
    def _normalize_scope_identifier(
        scope_or_id: Optional[str],
        expected_kind: str,
        provider: str,
    ) -> Optional[str]:
        if scope_or_id is None:
            return None
        cleaned = scope_or_id.strip()
        if not cleaned:
            return None
        if cleaned.startswith("provider:"):
            try:
                parsed = parse_provider_scope(cleaned)
            except ScopeParseError as e:
                raise ProviderConfigurationError(str(e)) from e
            if parsed["kind"] != expected_kind:
                raise ProviderConfigurationError(
                    f"Expected {expected_kind} scope but got {parsed['kind']}: {cleaned}"
                )
            if parsed["provider_name"] != provider:
                raise ProviderConfigurationError(
                    f"Scope provider '{parsed['provider_name']}' does not match request provider '{provider}'"
                )
            return parsed["identifier"]
        return cleaned

    @staticmethod
    def _status_from_circuit_state(state: CircuitState) -> str:
        """Translate circuit state to simple operational status."""
        if state == CircuitState.CLOSED:
            return "healthy"
        if state == CircuitState.HALF_OPEN:
            return "degraded"
        return "unavailable"
