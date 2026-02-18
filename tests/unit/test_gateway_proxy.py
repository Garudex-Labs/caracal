"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Gateway Proxy server.

Tests the main GatewayProxy functionality:
- Request handling flow
- Authentication integration
- Replay protection integration
- Authority evaluation integration (Mandates)
- Request forwarding
- Usage metering
"""

import pytest
from decimal import Decimal
from datetime import datetime
from unittest.mock import Mock, AsyncMock, patch
from uuid import uuid4

from caracal.gateway.proxy import GatewayProxy, GatewayConfig
from caracal.gateway.auth import Authenticator, AuthenticationMethod, AuthenticationResult
from caracal.gateway.replay_protection import ReplayProtection, ReplayCheckResult
from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
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
def mock_authority_evaluator():
    """Create a mock authority evaluator."""
    return Mock(spec=AuthorityEvaluator)


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
    mock_authority_evaluator,
    mock_metering_collector,
    mock_replay_protection
):
    """Create a GatewayProxy instance for testing."""
    return GatewayProxy(
        config=gateway_config,
        authenticator=mock_authenticator,
        authority_evaluator=mock_authority_evaluator,
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
        assert gateway_proxy.authority_evaluator is not None
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


class TestGatewayProxyAuthorityEvaluation:
    """Test authority (mandate) evaluation."""
    
    @pytest.mark.asyncio
    async def test_authority_check_allowed(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_authority_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test authority check allows request with valid mandate."""
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
        
        # Mock authority evaluation success
        mandate_id = str(uuid4())
        mock_mandate = Mock()
        mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Mandate valid"
        )
        
        # Mock HTTP client streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.content = b'{"result": "success"}'
        mock_stream_response.headers = {"content-type": "application/json"}
        mock_stream_response.request = Mock()
        
        async def mock_aiter_bytes():
            yield b'{"result": "success"}'
        mock_stream_response.aiter_bytes = mock_aiter_bytes
        
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
                "X-Caracal-Mandate-ID": mandate_id
            },
            json={"test": "data"}
        )
        
        # Verify response
        assert response.status_code == 200
        
        # Verify authority evaluator called
        mock_authority_evaluator._get_mandate_with_cache.assert_called()
        mock_authority_evaluator.validate_mandate.assert_called()
        
        # Verify stats
        assert gateway_proxy._allowed_count == 1
        assert gateway_proxy._denied_count == 0

    @pytest.mark.asyncio
    async def test_authority_check_denied(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_authority_evaluator,
        mock_replay_protection,
        sample_agent
    ):
        """Test authority check denies request."""
        from fastapi.testclient import TestClient
        
        # Mock authentication success
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        
        # Mock replay protection
        mock_replay_protection.check_request = AsyncMock(return_value=ReplayCheckResult(allowed=True))
        
        # Mock authority evaluation denial
        mandate_id = str(uuid4())
        mock_mandate = Mock()
        mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=False,
            reason="Mandate expired"
        )
        
        client = TestClient(gateway_proxy.app)
        
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Mandate-ID": mandate_id
            },
            json={"test": "data"}
        )
        
        assert response.status_code == 403
        assert response.json()["error"] == "authority_denied"
        assert gateway_proxy._denied_count == 1

    @pytest.mark.asyncio
    async def test_authority_check_missing_mandate(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_replay_protection,
        sample_agent
    ):
        """Test request without mandate ID returns 400."""
        from fastapi.testclient import TestClient
        
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        mock_replay_protection.check_request = AsyncMock(return_value=ReplayCheckResult(allowed=True))
        
        client = TestClient(gateway_proxy.app)
        
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test"
                # Missing X-Caracal-Mandate-ID
            },
            json={"test": "data"}
        )
        
        assert response.status_code == 400
        assert "Missing X-Caracal-Mandate-ID" in response.json()["error"]


class TestGatewayProxyMetering:
    """Test usage metering."""
    
    @pytest.mark.asyncio
    async def test_metering_collection(
        self,
        gateway_proxy,
        mock_authenticator,
        mock_authority_evaluator,
        mock_metering_collector,
        mock_replay_protection,
        sample_agent
    ):
        """Test metering event is collected on successful request."""
        from fastapi.testclient import TestClient
        
        mock_authenticator.authenticate_jwt = AsyncMock(
            return_value=AuthenticationResult(
                success=True,
                agent_identity=sample_agent,
                method=AuthenticationMethod.JWT
            )
        )
        mock_replay_protection.check_request = AsyncMock(return_value=ReplayCheckResult(allowed=True))
        
        mandate_id = str(uuid4())
        mock_authority_evaluator._get_mandate_with_cache.return_value = Mock()
        mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(allowed=True)
        
        # Mock streaming response
        mock_stream_response = AsyncMock()
        mock_stream_response.status_code = 200
        mock_stream_response.headers = {}
        mock_stream_response.request = Mock()
        async def mock_aiter_bytes(): yield b'data'
        mock_stream_response.aiter_bytes = mock_aiter_bytes
        
        mock_stream_context = AsyncMock()
        mock_stream_context.__aenter__ = AsyncMock(return_value=mock_stream_response)
        mock_stream_context.__aexit__ = AsyncMock(return_value=None)
        gateway_proxy.http_client.stream = Mock(return_value=mock_stream_context)
        
        client = TestClient(gateway_proxy.app)
        
        response = client.post(
            "/api/test",
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Target-URL": "https://api.example.com/test",
                "X-Caracal-Mandate-ID": mandate_id,
                "X-Caracal-Resource-Type": "model_inference"
            },
            json={"test": "data"}
        )
        
        assert response.status_code == 200
        
        # Verify metering
        mock_metering_collector.collect_event.assert_called_once()
        event = mock_metering_collector.collect_event.call_args[0][0]
        assert event.agent_id == sample_agent.agent_id
        assert event.resource_type == "model_inference"
        # Quantity should be response size (4 bytes "data")
        assert event.quantity == Decimal("4")


class TestGatewayProxyHealthCheck:
    """Test health check endpoint."""
    
    def test_health_check(self, gateway_proxy):
        """Test health check returns healthy."""
        from fastapi.testclient import TestClient
        client = TestClient(gateway_proxy.app)
        
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "caracal-gateway-proxy"
