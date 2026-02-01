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
        
        # Mock HTTP client response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.content = b'{"result": "success"}'
        mock_response.headers = {"content-type": "application/json"}
        
        gateway_proxy.http_client.request = AsyncMock(return_value=mock_response)
        
        # Forward request
        response = await gateway_proxy.forward_request(
            mock_request,
            "https://api.example.com/endpoint"
        )
        
        # Verify
        assert response.status_code == 200
        assert response.content == b'{"result": "success"}'
        gateway_proxy.http_client.request.assert_called_once()


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
        
        # Mock HTTP client for forwarding
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.content = b'{"result": "success"}'
        mock_response.headers = {"content-type": "application/json"}
        gateway_proxy.http_client.request = AsyncMock(return_value=mock_response)
        
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
        
        # Verify request was NOT forwarded
        gateway_proxy.http_client.request.assert_not_called()
    
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
        
        # Mock HTTP client for forwarding
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.content = b'{"result": "success"}'
        mock_response.headers = {"content-type": "application/json"}
        gateway_proxy.http_client.request = AsyncMock(return_value=mock_response)
        
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
        
        # Verify response is 500 Internal Server Error
        assert response.status_code == 500
        data = response.json()
        assert data["error"] == "policy_evaluation_failed"
        assert "Failed to query spending" in data["message"]
        
        # Verify request was NOT forwarded
        gateway_proxy.http_client.request.assert_not_called()

