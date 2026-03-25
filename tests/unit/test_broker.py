"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Broker functionality.
"""

import asyncio
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

from caracal.deployment.broker import (
    Broker,
    CircuitBreaker,
    CircuitState,
    ProviderConfig,
    ProviderRequest,
    RateLimit,
)
from caracal.deployment.exceptions import (
    CircuitBreakerOpenError,
    ProviderAuthenticationError,
    ProviderNotFoundError,
    ProviderRateLimitError,
)


class TestCircuitBreaker:
    """Test circuit breaker functionality."""
    
    def test_circuit_breaker_closed_state(self):
        """Test circuit breaker in closed state allows calls."""
        cb = CircuitBreaker(failure_threshold=3)
        
        def success_func():
            return "success"
        
        result = cb.call(success_func)
        assert result == "success"
        assert cb.state == CircuitState.CLOSED
        assert cb.failure_count == 0
    
    def test_circuit_breaker_opens_after_threshold(self):
        """Test circuit breaker opens after failure threshold."""
        cb = CircuitBreaker(failure_threshold=3)
        
        def failing_func():
            raise Exception("Test error")
        
        # Trigger failures
        for i in range(3):
            try:
                cb.call(failing_func)
            except Exception:
                pass
        
        assert cb.state == CircuitState.OPEN
        assert cb.failure_count == 3
        assert cb.opened_at is not None
    
    def test_circuit_breaker_open_rejects_calls(self):
        """Test circuit breaker in open state rejects calls."""
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=60)
        
        def failing_func():
            raise Exception("Test error")
        
        # Open the circuit
        try:
            cb.call(failing_func)
        except Exception:
            pass
        
        assert cb.state == CircuitState.OPEN
        
        # Next call should be rejected
        with pytest.raises(CircuitBreakerOpenError):
            cb.call(lambda: "success")
    
    def test_circuit_breaker_half_open_transition(self):
        """Test circuit breaker transitions to half-open after timeout."""
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=0)
        
        def failing_func():
            raise Exception("Test error")
        
        # Open the circuit
        try:
            cb.call(failing_func)
        except Exception:
            pass
        
        assert cb.state == CircuitState.OPEN
        
        # After timeout, should transition to half-open
        import time
        time.sleep(0.1)
        
        # Next call should attempt half-open
        try:
            cb.call(lambda: "success")
        except Exception:
            pass
        
        # Should have transitioned to half-open
        assert cb.state == CircuitState.CLOSED  # Success closes it


class TestRateLimit:
    """Test rate limiting functionality."""
    
    def test_rate_limit_allows_within_limit(self):
        """Test rate limiter allows requests within limit."""
        rl = RateLimit(requests_per_minute=60)
        rl.tokens = 10  # Pre-fill tokens
        
        assert rl.consume(1) is True
        assert rl.tokens == 9
    
    def test_rate_limit_blocks_over_limit(self):
        """Test rate limiter blocks requests over limit."""
        rl = RateLimit(requests_per_minute=60)
        rl.tokens = 0
        
        assert rl.consume(1) is False
        assert rl.tokens == 0
    
    def test_rate_limit_refills_over_time(self):
        """Test rate limiter refills tokens over time."""
        import time
        
        rl = RateLimit(requests_per_minute=60)
        rl.tokens = 0
        rl.last_refill = datetime.now()
        
        # Wait a bit for refill
        time.sleep(0.1)
        
        # Should have refilled some tokens
        rl._refill()
        assert rl.tokens > 0


class TestBroker:
    """Test Broker functionality."""
    
    @pytest.fixture
    def mock_config_manager(self):
        """Create mock config manager."""
        manager = MagicMock()
        manager.get_secret.return_value = "test-api-key"
        return manager
    
    @pytest.fixture
    def broker(self, mock_config_manager):
        """Create broker instance."""
        return Broker(config_manager=mock_config_manager, workspace="test")
    
    def test_configure_provider(self, broker):
        """Test provider configuration."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key",
            rate_limit_rpm=60
        )
        
        broker.configure_provider("test-provider", config)
        
        assert "test-provider" in broker._providers
        assert "test-provider" in broker._rate_limiters
        assert broker._rate_limiters["test-provider"].requests_per_minute == 60
    
    def test_list_providers(self, broker):
        """Test listing providers."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key"
        )
        
        broker.configure_provider("test-provider", config)
        
        providers = broker.list_providers()
        assert len(providers) == 1
        assert providers[0].name == "test-provider"
        assert providers[0].provider_type == "openai"
        assert providers[0].circuit_state == CircuitState.CLOSED
    
    def test_get_provider_metrics(self, broker):
        """Test getting provider metrics."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key"
        )
        
        broker.configure_provider("test-provider", config)
        
        # Initialize some metrics
        broker._metrics["test-provider"]["total_requests"] = 10
        broker._metrics["test-provider"]["successful_requests"] = 8
        broker._metrics["test-provider"]["failed_requests"] = 2
        broker._metrics["test-provider"]["total_latency_ms"] = 800.0
        
        metrics = broker.get_provider_metrics("test-provider")
        
        assert metrics.provider == "test-provider"
        assert metrics.total_requests == 10
        assert metrics.successful_requests == 8
        assert metrics.failed_requests == 2
        assert metrics.average_latency_ms == 100.0
        assert metrics.circuit_state == CircuitState.CLOSED
    
    def test_call_provider_not_configured(self, broker):
        """Test calling unconfigured provider raises error."""
        request = ProviderRequest(
            provider="unknown",
            method="GET",
            endpoint="/test"
        )
        
        with pytest.raises(ProviderNotFoundError):
            asyncio.run(broker.call_provider("unknown", request))
    
    def test_rate_limit_exceeded(self, broker):
        """Test rate limit exceeded raises error."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key",
            rate_limit_rpm=60
        )
        
        broker.configure_provider("test-provider", config)
        
        # Exhaust rate limit
        broker._rate_limiters["test-provider"].tokens = 0
        
        request = ProviderRequest(
            provider="test-provider",
            method="GET",
            endpoint="/test"
        )
        
        with pytest.raises(ProviderRateLimitError):
            asyncio.run(broker.call_provider("test-provider", request))
    
    @pytest.mark.asyncio
    async def test_call_provider_success(self, broker, mock_config_manager):
        """Test successful provider call."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key",
            max_retries=1
        )
        
        broker.configure_provider("test-provider", config)
        
        # Mock HTTP client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"result": "success"}
        mock_response.content = b'{"result": "success"}'
        
        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        
        with patch.object(broker, '_get_client', return_value=mock_client):
            request = ProviderRequest(
                provider="test-provider",
                method="GET",
                endpoint="/test"
            )
            
            response = await broker.call_provider("test-provider", request)
            
            assert response.status_code == 200
            assert response.data == {"result": "success"}
            assert response.error is None
            assert response.latency_ms > 0
    
    @pytest.mark.asyncio
    async def test_call_provider_authentication_error(self, broker, mock_config_manager):
        """Test provider call with authentication error."""
        config = ProviderConfig(
            name="test-provider",
            provider_type="openai",
            api_key_ref="test_key",
            max_retries=1
        )
        
        broker.configure_provider("test-provider", config)
        
        # Mock HTTP client with 401 response
        mock_response = MagicMock()
        mock_response.status_code = 401
        
        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        
        with patch.object(broker, '_get_client', return_value=mock_client):
            request = ProviderRequest(
                provider="test-provider",
                method="GET",
                endpoint="/test"
            )
            
            with pytest.raises(ProviderAuthenticationError):
                await broker.call_provider("test-provider", request)
    
    @pytest.mark.asyncio
    async def test_close_client(self, broker):
        """Test closing HTTP client."""
        # Create client
        await broker._get_client()
        assert broker._client is not None
        
        # Close client
        await broker.close()
        assert broker._client is None
