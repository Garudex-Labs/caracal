"""
Unit tests for Gateway Proxy server.

Tests the main GatewayProxy functionality:
- Request handling flow
- Authentication integration
- Replay protection integration
- Policy evaluation integration
- Request forwarding
"""

import pytest
from decimal import Decimal
from datetime import datetime
from unittest.mock import Mock, AsyncMock, patch

from caracal.gateway.proxy import GatewayProxy, GatewayConfig
from caracal.gateway.auth import Authenticator, AuthenticationMethod, AuthenticationResult
from caracal.gateway.replay_protection import ReplayProtection, ReplayCheckResult
from caracal.core.policy import PolicyEvaluator, PolicyDecision
from caracal.core.metering import MeteringCollector
from caracal.core.identity import AgentIdentity


@pytest.fixture
def gateway_config():
    """Create a test gateway configuration."""
    return GatewayConfig(
        listen_address="127.0.0.1:8443",
        auth_mode="jwt",
        enable_replay_protection=True,
        request_timeout_seconds=10
    )


@pytest.fixture
def mock_authenticator():
    """Create a mock authenticator."""
    return Mock(spec=Authenticator)


@pytest.fixture
def mock_policy_evaluator():
    """Create a mock policy evaluator."""
    return Mock(spec=PolicyEvaluator)


@pytest.fixture
def mock_metering_collector():
    """Create a mock metering collector."""
    return Mock(spec=MeteringCollector)


@pytest.fixture
def mock_replay_protection():
    """Create a mock replay protection."""
    return Mock(spec=ReplayProtection)


@pytest.fixture
def gateway_proxy(
    gateway_config,
    mock_authenticator,
    mock_policy_evaluator,
    mock_metering_collector,
    mock_replay_protection
):
    """Create a GatewayProxy instance for testing."""
    return GatewayProxy(
        config=gateway_config,
        authenticator=mock_authenticator,
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector,
        replay_protection=mock_replay_protection
    )


@pytest.fixture
def sample_agent():
    """Create a sample agent identity."""
    return AgentIdentity(
        agent_id="550e8400-e29b-41d4-a716-446655440000",
        name="test-agent",
        owner="test@example.com",
        created_at=datetime.utcnow().isoformat() + "Z",
        metadata={}
    )


class TestGatewayProxyInitialization:
    """Test GatewayProxy initialization."""
    
    def test_initialization(self, gateway_proxy, gateway_config):
        """Test that GatewayProxy initializes correctly."""
        assert gateway_proxy.config == gateway_config
        assert gateway_proxy.authenticator is not None
        assert gateway_proxy.policy_evaluator is not None
        assert gateway_proxy.metering_collector is not None
        assert gateway_proxy.replay_protection is not None
        assert gateway_proxy.app is not None
        assert gateway_proxy.http_client is not None
    
    def test_statistics_initialization(self, gateway_proxy):
        """Test that statistics are initialized to zero."""
        assert gateway_proxy._request_count == 0
        assert gateway_proxy._allowed_count == 0
        assert gateway_proxy._denied_count == 0
        assert gateway_proxy._auth_failures == 0
        assert gateway_proxy._replay_blocks == 0


class TestGatewayProxyAuthentication:
    """Test authentication integration."""
    
    @pytest.mark.asyncio
    async def test_authenticate_agent_jwt_success(
        self,
        gateway_proxy,
        mock_authenticator,
        sample_agent
    ):
        """Test successful JWT authentication."""
        # Mock request with JWT token
        mock_request = Mock()
        mock_request.headers = {
            "Authorization": "Bearer test-token-12345"
        }
        
        # Mock authenticator response
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Authenticate
        result = await gateway_proxy.authenticate_agent(mock_request)
        
        # Verify
        assert result.success is True
        assert result.agent_identity == sample_agent
        assert result.method == AuthenticationMethod.JWT
        mock_authenticator.authenticate_jwt.assert_called_once_with("test-token-12345")
    
    @pytest.mark.asyncio
    async def test_authenticate_agent_jwt_missing_header(self, gateway_proxy):
        """Test JWT authentication with missing Authorization header."""
        # Mock request without Authorization header
        mock_request = Mock()
        mock_request.headers = {}
        
        # Authenticate
        result = await gateway_proxy.authenticate_agent(mock_request)
        
        # Verify
        assert result.success is False
        assert "No Authorization header" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_agent_jwt_invalid_format(self, gateway_proxy):
        """Test JWT authentication with invalid Authorization header format."""
        # Mock request with invalid Authorization header
        mock_request = Mock()
        mock_request.headers = {
            "Authorization": "InvalidFormat"
        }
        
        # Authenticate
        result = await gateway_proxy.authenticate_agent(mock_request)
        
        # Verify
        assert result.success is False
        assert "Invalid Authorization header format" in result.error
    
    @pytest.mark.asyncio
    async def test_authenticate_agent_api_key_success(
        self,
        gateway_proxy,
        mock_authenticator,
        sample_agent
    ):
        """Test successful API key authentication."""
        # Configure gateway for API key auth
        gateway_proxy.config.auth_mode = "api_key"
        
        # Mock request with API key
        mock_request = Mock()
        mock_request.headers = {
            "X-API-Key": "test-api-key-12345"
        }
        
        # Mock authenticator response
        mock_authenticator.authenticate_api_key = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.API_KEY
            )
        )
        
        # Authenticate
        result = await gateway_proxy.authenticate_agent(mock_request)
        
        # Verify
        assert result.success is True
        assert result.agent_identity == sample_agent
        assert result.method == AuthenticationMethod.API_KEY
        mock_authenticator.authenticate_api_key.assert_called_once_with("test-api-key-12345")


class TestGatewayProxyReplayProtection:
    """Test replay protection integration."""
    
    @pytest.mark.asyncio
    async def test_check_replay_with_nonce(
        self,
        gateway_proxy,
        mock_replay_protection
    ):
        """Test replay check with nonce."""
        # Mock request with nonce
        mock_request = Mock()
        mock_request.headers = {
            "X-Caracal-Nonce": "unique-nonce-12345"
        }
        
        # Mock replay protection response
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(
                allowed=True,
                nonce_validated=True,
                timestamp_validated=False
            )
        )
        
        # Check replay
        result = await gateway_proxy.check_replay(mock_request)
        
        # Verify
        assert result.allowed is True
        assert result.nonce_validated is True
        mock_replay_protection.check_request.assert_called_once_with(
            nonce="unique-nonce-12345",
            timestamp=None
        )
    
    @pytest.mark.asyncio
    async def test_check_replay_with_timestamp(
        self,
        gateway_proxy,
        mock_replay_protection
    ):
        """Test replay check with timestamp."""
        # Mock request with timestamp
        mock_request = Mock()
        mock_request.headers = {
            "X-Caracal-Timestamp": "1735603200"
        }
        
        # Mock replay protection response
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(
                allowed=True,
                nonce_validated=False,
                timestamp_validated=True
            )
        )
        
        # Check replay
        result = await gateway_proxy.check_replay(mock_request)
        
        # Verify
        assert result.allowed is True
        assert result.timestamp_validated is True
        mock_replay_protection.check_request.assert_called_once_with(
            nonce=None,
            timestamp=1735603200
        )
    
    @pytest.mark.asyncio
    async def test_check_replay_blocked(
        self,
        gateway_proxy,
        mock_replay_protection
    ):
        """Test replay check that blocks request."""
        # Mock request with nonce
        mock_request = Mock()
        mock_request.headers = {
            "X-Caracal-Nonce": "duplicate-nonce"
        }
        
        # Mock replay protection response (blocked)
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(
                allowed=False,
                reason="Nonce already used",
                nonce_validated=True,
                timestamp_validated=False
            )
        )
        
        # Check replay
        result = await gateway_proxy.check_replay(mock_request)
        
        # Verify
        assert result.allowed is False
        assert "Nonce already used" in result.reason


class TestGatewayProxyRequestForwarding:
    """Test request forwarding."""
    
    @pytest.mark.asyncio
    async def test_forward_request_success(self, gateway_proxy):
        """Test successful request forwarding."""
        # Mock request
        mock_request = Mock()
        mock_request.method = "POST"
        mock_request.headers = {
            "Content-Type": "application/json",
            "X-Caracal-Target-URL": "https://api.example.com/endpoint"
        }
        mock_request.body = AsyncMock(return_value=b'{"test": "data"}')
        
        # Mock HTTP client streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Mock streaming chunks
        async def mock_aiter_bytes():
            yield b'{"result": '
            yield b'"success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes
        
        # Mock the stream context manager
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Forward request
        response = await gateway_proxy.forward_request(
            mock_request,
            "https://api.example.com/endpoint"
        )
        
        # Verify
        assert response.status_code == 200
        assert response.content == b'{"result": "success"}'
        gateway_proxy.http_client.stream.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_forward_request_streaming_large_response(self, gateway_proxy):
        """Test request forwarding with large streaming response."""
        # Mock request
        mock_request = Mock()
        mock_request.method = "GET"
        mock_request.headers = {
            "Accept": "application/json",
            "X-Caracal-Target-URL": "https://api.example.com/large-data"
        }
        mock_request.body = AsyncMock(return_value=b'')
        
        # Mock HTTP client streaming response with large chunks
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Mock streaming large chunks (simulate 10KB response)
        large_chunk = b'x' * 1024  # 1KB chunk
        async def mock_aiter_bytes():
            for _ in range(10):
                yield large_chunk
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes
        
        # Mock the stream context manager
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Forward request
        response = await gateway_proxy.forward_request(
            mock_request,
            "https://api.example.com/large-data"
        )
        
        # Verify
        assert response.status_code == 200
        assert len(response.content) == 10240  # 10KB
        assert response.content == large_chunk * 10
    
    @pytest.mark.asyncio
    async def test_forward_request_removes_caracal_headers(self, gateway_proxy):
        """Test that Caracal-specific headers are removed before forwarding."""
        # Mock request with Caracal headers
        mock_request = Mock()
        mock_request.method = "POST"
        mock_request.headers = {
            "Content-Type": "application/json",
            "X-Caracal-Target-URL": "https://api.example.com/endpoint",
            "X-Caracal-Estimated-Cost": "0.01",
            "X-Caracal-Nonce": "test-nonce",
            "X-API-Key": "secret-key",
            "Authorization": "Bearer token"
        }
        mock_request.body = AsyncMock(return_value=b'{"test": "data"}')
        
        # Mock HTTP client streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes
        
        # Mock the stream context manager
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Forward request
        await gateway_proxy.forward_request(
            mock_request,
            "https://api.example.com/endpoint"
        )
        
        # Verify that stream was called
        gateway_proxy.http_client.stream.assert_called_once()
        
        # Get the headers that were passed to stream
        call_kwargs = gateway_proxy.http_client.stream.call_args[1]
        forwarded_headers = call_kwargs['headers']
        
        # Verify Caracal headers were removed
        # Note: HTTP headers are case-insensitive, check both cases
        forwarded_headers_lower = {k.lower(): v for k, v in forwarded_headers.items()}
        assert "x-caracal-target-url" not in forwarded_headers_lower
        assert "x-caracal-estimated-cost" not in forwarded_headers_lower
        assert "x-caracal-nonce" not in forwarded_headers_lower
        assert "x-api-key" not in forwarded_headers_lower
        
        # Verify non-Caracal headers were kept
        assert forwarded_headers_lower.get("content-type") == "application/json"
        assert forwarded_headers_lower.get("authorization") == "Bearer token"
    
    @pytest.mark.asyncio
    async def test_forward_request_timeout(self, gateway_proxy):
        """Test request forwarding with timeout."""
        import httpx
        
        # Mock request
        mock_request = Mock()
        mock_request.method = "GET"
        mock_request.headers = {"X-Caracal-Target-URL": "https://api.example.com/slow"}
        mock_request.body = AsyncMock(return_value=b'')
        
        # Mock timeout exception
        gateway_proxy.http_client.stream = Mock(side_effect=httpx.TimeoutException("Request timeout"))
        
        # Forward request should raise timeout
        with pytest.raises(httpx.TimeoutException):
            await gateway_proxy.forward_request(
                mock_request,
                "https://api.example.com/slow"
            )


class TestGatewayProxyStatistics:
    """Test statistics tracking."""
    
    def test_get_stats(self, gateway_proxy, mock_replay_protection):
        """Test statistics retrieval."""
        # Set some statistics
        gateway_proxy._request_count = 100
        gateway_proxy._allowed_count = 80
        gateway_proxy._denied_count = 15
        gateway_proxy._auth_failures = 5
        gateway_proxy._replay_blocks = 3
        
        # Mock replay protection stats
        mock_replay_protection.get_stats.return_value = {
            "nonce_checks": 97,
            "nonce_replays_blocked": 3
        }
        
        # Get stats via FastAPI app
        from fastapi.testclient import TestClient
        client = TestClient(gateway_proxy.app)
        
        response = client.get("/stats")
        
        # Verify
        assert response.status_code == 200
        stats = response.json()
        assert stats["requests_total"] == 100
        assert stats["requests_allowed"] == 80
        assert stats["requests_denied"] == 15
        assert stats["auth_failures"] == 5
        assert stats["replay_blocks"] == 3
        assert "replay_protection" in stats


class TestGatewayProxyHealthCheck:
    """Test health check endpoint."""
    
    def test_health_check(self, gateway_proxy):
        """Test health check endpoint."""
        from fastapi.testclient import TestClient
        client = TestClient(gateway_proxy.app)
        
        response = client.get("/health")
        
        # Verify
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "caracal-gateway-proxy"
        assert data["version"] == "0.2.0"


class TestGatewayProxyPolicyEvaluation:
    """Test policy evaluation integration (Task 8.2)."""
    
    @pytest.mark.asyncio
    async def test_policy_check_allowed_with_provisional_charge(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test policy check that allows request and creates provisional charge."""
        from fastapi.testclient import TestClient
        from uuid import uuid4
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success with provisional charge
        provisional_charge_id = str(uuid4())
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("50.00"),
            provisional_charge_id=provisional_charge_id
        )
        
        # Mock HTTP client streaming response for forwarding
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.content = b'{"result": "success"}'
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_policy():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_policy
        
        # Mock the stream context manager
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "10.00"
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify policy evaluator was called with correct parameters
        mock_policy_evaluator.check_budget.assert_called_once()
        call_args = mock_policy_evaluator.check_budget.call_args
        assert call_args[1]["agent_id"] == str(sample_agent.agent_id)
        assert call_args[1]["estimated_cost"] == Decimal("10.00")
        
        # Verify statistics
        assert gateway_proxy._allowed_count == 1
        assert gateway_proxy._denied_count == 0
    
    @pytest.mark.asyncio
    async def test_policy_check_denied_returns_403(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test policy check that denies request returns 403 (Requirement 1.5)."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation denial
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=False,
            reason="Insufficient budget: need 100.00, available 50.00 USD",
            remaining_budget=Decimal("0")
        )
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "100.00"
            },
            json={"test": "data"}
        )
        
        # Verify response is 403 Forbidden
        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "budget_exceeded"
        assert "Insufficient budget" in data["message"]
        assert data["remaining_budget"] == "0"
        
        # Verify policy evaluator was called
        mock_policy_evaluator.check_budget.assert_called_once()
        
        # Verify statistics
        assert gateway_proxy._denied_count == 1
        assert gateway_proxy._allowed_count == 0
        
        # Verify request was NOT forwarded (stream should not be called)
        # Note: We don't check http_client.request since it's not mocked in this test
    
    @pytest.mark.asyncio
    async def test_policy_check_without_estimated_cost(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test policy check without estimated cost header."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success without provisional charge
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("100.00"),
            provisional_charge_id=None
        )
        
        # Mock HTTP client streaming response for forwarding
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.content = b'{"result": "success"}'
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_no_cost():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_no_cost
        
        # Mock the stream context manager
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request without estimated cost
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test"
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify policy evaluator was called with None estimated cost
        mock_policy_evaluator.check_budget.assert_called_once()
        call_args = mock_policy_evaluator.check_budget.call_args
        assert call_args[1]["estimated_cost"] is None
    
    @pytest.mark.asyncio
    async def test_policy_evaluation_error_returns_500(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test policy evaluation error returns 500."""
        from fastapi.testclient import TestClient
        from caracal.exceptions import PolicyEvaluationError
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation error
        mock_policy_evaluator.check_budget.side_effect = PolicyEvaluationError(
            "Failed to query spending"
        )
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "10.00"
            },
            json={"test": "data"}
        )
        
        # Verify response is 503 Service Unavailable (fail-closed behavior)
        assert response.status_code == 503
        data = response.json()
        assert data["error"] == "policy_service_unavailable"
        assert "Policy service unavailable" in data["message"]
        
        # Verify request was NOT forwarded (no stream call should happen)
        # Note: We don't check http_client.request since it's not mocked in this test



class TestGatewayProxyFinalChargeEmission:
    """Test final charge emission after request forwarding (Task 8.3)."""
    
    @pytest.mark.asyncio
    async def test_final_charge_emission_with_actual_cost_header(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test final charge emission when X-Caracal-Actual-Cost header is present."""
        from fastapi.testclient import TestClient
        from uuid import uuid4
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success with provisional charge
        provisional_charge_id = str(uuid4())
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("50.00"),
            provisional_charge_id=provisional_charge_id
        )
        
        # Mock HTTP client streaming response with actual cost header
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {
            "content-type": "application/json",
            "X-Caracal-Actual-Cost": "8.50"
        }
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_2():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_2
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "10.00",
                "X-Caracal-Resource-Type": "api_call"
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify metering collector was called
        mock_metering_collector.collect_event.assert_called_once()
        
        # Verify metering event details
        call_args = mock_metering_collector.collect_event.call_args
        metering_event = call_args[0][0]
        assert metering_event.agent_id == str(sample_agent.agent_id)
        assert metering_event.resource_type == "api_call"
        assert metering_event.metadata["actual_cost"] == "8.50"
        assert metering_event.metadata["estimated_cost"] == "10.00"
        assert metering_event.metadata["status_code"] == 200
        assert metering_event.metadata["provisional_charge_id"] == provisional_charge_id
        
        # Verify provisional charge ID was passed
        assert call_args[1]["provisional_charge_id"] == provisional_charge_id
    
    @pytest.mark.asyncio
    async def test_final_charge_emission_without_actual_cost_header(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test final charge emission when X-Caracal-Actual-Cost header is missing."""
        from fastapi.testclient import TestClient
        from uuid import uuid4
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success with provisional charge
        provisional_charge_id = str(uuid4())
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("50.00"),
            provisional_charge_id=provisional_charge_id
        )
        
        # Mock HTTP client streaming response WITHOUT actual cost header
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_3():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_3
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request with estimated cost
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "10.00"
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify metering collector was called
        mock_metering_collector.collect_event.assert_called_once()
        
        # Verify metering event uses estimated cost when actual cost is missing
        call_args = mock_metering_collector.collect_event.call_args
        metering_event = call_args[0][0]
        assert metering_event.metadata["actual_cost"] == "10.00"  # Falls back to estimated
        assert metering_event.metadata["estimated_cost"] == "10.00"
    
    @pytest.mark.asyncio
    async def test_final_charge_emission_with_response_size_metering(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test final charge emission meters response size when no cost provided."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success without provisional charge
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("100.00"),
            provisional_charge_id=None
        )
        
        # Mock HTTP client streaming response with large content
        large_response = b'x' * 5000  # 5KB response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_4():
            yield large_response
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_4
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request without estimated cost
        response = client.get(
            "/api/data",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/data"
            }
        )
        
        # Verify response
        assert response.status_code == 200
        assert len(response.content) == 5000
        
        # Verify metering collector was called
        mock_metering_collector.collect_event.assert_called_once()
        
        # Verify metering event includes response size
        call_args = mock_metering_collector.collect_event.call_args
        metering_event = call_args[0][0]
        assert metering_event.metadata["response_size_bytes"] == 5000
        # When no cost provided, quantity should be response size in bytes
        assert metering_event.quantity == Decimal("5000")
    
    @pytest.mark.asyncio
    async def test_final_charge_emission_failure_does_not_block_response(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test that metering failures don't block the response to the client."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("100.00"),
            provisional_charge_id=None
        )
        
        # Mock HTTP client streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_5():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_5
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Mock metering collector to raise exception
        mock_metering_collector.collect_event.side_effect = Exception("Database connection failed")
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Estimated-Cost": "10.00"
            },
            json={"test": "data"}
        )
        
        # Verify response is still successful despite metering failure
        assert response.status_code == 200
        assert response.json() == {"result": "success"}
        
        # Verify metering collector was called (and failed)
        mock_metering_collector.collect_event.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_final_charge_emission_with_custom_resource_type(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_policy_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test final charge emission with custom resource type."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection success
        mock_replay_protection.check_request = AsyncMock(
            return_value=ReplayCheckResult(allowed=True)
        )
        
        # Mock policy evaluation success
        mock_policy_evaluator.check_budget.return_value = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("100.00"),
            provisional_charge_id=None
        )
        
        # Mock HTTP client streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        # Create an async generator for aiter_bytes
        async def mock_aiter_bytes_6():
            yield b'{"result": "success"}'
        
        mock_stream_response.aiter_bytes = mock_aiter_bytes_6
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        # Create test client
        client = TestClient(gateway_proxy.app)
        
        # Make request with custom resource type
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Resource-Type": "llm_inference"
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify metering collector was called with custom resource type
        mock_metering_collector.collect_event.assert_called_once()
        call_args = mock_metering_collector.collect_event.call_args
        metering_event = call_args[0][0]
        assert metering_event.resource_type == "llm_inference"



class TestGatewayProxyHealthCheck:
    """Test Gateway Proxy health check endpoint."""
    
    @pytest.mark.asyncio
    async def test_health_check_healthy_without_db(self, gateway_proxy):
        """Test health check returns healthy when no database configured."""
        from fastapi.testclient import TestClient
        
        client = TestClient(gateway_proxy.app)
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "caracal-gateway-proxy"
        assert data["version"] == "0.2.0"
        assert "checks" in data
        assert data["checks"]["database"] == "not_configured"
    
    @pytest.mark.asyncio
    async def test_health_check_healthy_with_db(self, gateway_proxy):
        """Test health check returns healthy when database is healthy."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = True
        gateway_proxy.db_connection_manager = mock_db_manager
        
        client = TestClient(gateway_proxy.app)
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["checks"]["database"] == "healthy"
        mock_db_manager.health_check.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_health_check_degraded_with_cache(self, gateway_proxy):
        """Test health check returns 503 degraded when database unhealthy but cache available."""
        from fastapi.testclient import TestClient
        from caracal.gateway.cache import PolicyCache, PolicyCacheConfig
        
        # Mock database connection manager (unhealthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = False
        gateway_proxy.db_connection_manager = mock_db_manager
        
        # Enable policy cache
        cache_config = PolicyCacheConfig(ttl_seconds=60, max_size=100)
        gateway_proxy.policy_cache = PolicyCache(cache_config)
        gateway_proxy.config.enable_policy_cache = True
        
        client = TestClient(gateway_proxy.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["checks"]["database"] == "unhealthy"
        assert data["checks"]["policy_cache"]["status"] == "enabled"
    
    @pytest.mark.asyncio
    async def test_health_check_unhealthy_without_cache(self, gateway_proxy):
        """Test health check returns 503 unhealthy when database unhealthy and no cache."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (unhealthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = False
        gateway_proxy.db_connection_manager = mock_db_manager
        
        # Disable policy cache
        gateway_proxy.policy_cache = None
        gateway_proxy.config.enable_policy_cache = False
        
        client = TestClient(gateway_proxy.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "unhealthy"
        assert data["checks"]["database"] == "unhealthy"
        assert data["checks"]["policy_cache"]["status"] == "disabled"
    
    @pytest.mark.asyncio
    async def test_health_check_db_exception(self, gateway_proxy):
        """Test health check handles database exceptions gracefully."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager that raises exception
        mock_db_manager = Mock()
        mock_db_manager.health_check.side_effect = Exception("Connection failed")
        gateway_proxy.db_connection_manager = mock_db_manager
        
        client = TestClient(gateway_proxy.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "unhealthy"
        assert "Exception" in data["checks"]["database"]
