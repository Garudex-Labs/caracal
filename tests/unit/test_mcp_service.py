"""
Unit tests for MCP Adapter Service.

Tests the MCPAdapterService functionality:
- Health check endpoint
- Database connectivity check
- MCP server connectivity check
- Degraded mode handling
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch
import httpx

from caracal.mcp.service import MCPAdapterService, MCPServiceConfig, MCPServerConfig
from caracal.mcp.adapter import MCPAdapter
from caracal.core.policy import PolicyEvaluator
from caracal.core.metering import MeteringCollector


@pytest.fixture
def mcp_service_config():
    """Create a test MCP service configuration."""
    return MCPServiceConfig(
        listen_address="127.0.0.1:8080",
        mcp_servers=[
            MCPServerConfig(name="test-server-1", url="http://localhost:9001"),
            MCPServerConfig(name="test-server-2", url="http://localhost:9002"),
        ],
        request_timeout_seconds=10
    )


@pytest.fixture
def mock_mcp_adapter():
    """Create a mock MCP adapter."""
    return Mock(spec=MCPAdapter)


@pytest.fixture
def mock_policy_evaluator():
    """Create a mock policy evaluator."""
    return Mock(spec=PolicyEvaluator)


@pytest.fixture
def mock_metering_collector():
    """Create a mock metering collector."""
    return Mock(spec=MeteringCollector)


@pytest.fixture
def mcp_service(
    mcp_service_config,
    mock_mcp_adapter,
    mock_policy_evaluator,
    mock_metering_collector
):
    """Create an MCPAdapterService instance for testing."""
    return MCPAdapterService(
        config=mcp_service_config,
        mcp_adapter=mock_mcp_adapter,
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector
    )


class TestMCPServiceInitialization:
    """Test MCPAdapterService initialization."""
    
    def test_initialization(self, mcp_service, mcp_service_config):
        """Test that MCPAdapterService initializes correctly."""
        assert mcp_service.config == mcp_service_config
        assert mcp_service.mcp_adapter is not None
        assert mcp_service.policy_evaluator is not None
        assert mcp_service.metering_collector is not None
        assert mcp_service.app is not None
        assert len(mcp_service.mcp_clients) == 2


class TestMCPServiceHealthCheck:
    """Test MCP Adapter Service health check endpoint."""
    
    @pytest.mark.asyncio
    async def test_health_check_all_healthy(self, mcp_service):
        """Test health check returns healthy when all dependencies are healthy."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (healthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = True
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (all healthy)
        for client in mcp_service.mcp_clients.values():
            mock_response = Mock()
            mock_response.status_code = 200
            client.get = AsyncMock(return_value=mock_response)
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "caracal-mcp-adapter"
        assert data["version"] == "0.2.0"
        assert data["mcp_servers"]["database"] == "healthy"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert data["mcp_servers"]["test-server-2"] == "healthy"
    
    @pytest.mark.asyncio
    async def test_health_check_degraded_db_unhealthy(self, mcp_service):
        """Test health check returns 503 degraded when database is unhealthy."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (unhealthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = False
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (all healthy)
        for client in mcp_service.mcp_clients.values():
            mock_response = Mock()
            mock_response.status_code = 200
            client.get = AsyncMock(return_value=mock_response)
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["mcp_servers"]["database"] == "unhealthy"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert data["mcp_servers"]["test-server-2"] == "healthy"
    
    @pytest.mark.asyncio
    async def test_health_check_degraded_mcp_server_unhealthy(self, mcp_service):
        """Test health check returns 503 degraded when MCP server is unhealthy."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (healthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = True
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (one unhealthy)
        clients = list(mcp_service.mcp_clients.values())
        
        # First server healthy
        mock_response_1 = Mock()
        mock_response_1.status_code = 200
        clients[0].get = AsyncMock(return_value=mock_response_1)
        
        # Second server unhealthy
        mock_response_2 = Mock()
        mock_response_2.status_code = 503
        clients[1].get = AsyncMock(return_value=mock_response_2)
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["mcp_servers"]["database"] == "healthy"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert "unhealthy" in data["mcp_servers"]["test-server-2"]
    
    @pytest.mark.asyncio
    async def test_health_check_mcp_server_timeout(self, mcp_service):
        """Test health check handles MCP server timeout."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (healthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = True
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (one times out)
        clients = list(mcp_service.mcp_clients.values())
        
        # First server healthy
        mock_response_1 = Mock()
        mock_response_1.status_code = 200
        clients[0].get = AsyncMock(return_value=mock_response_1)
        
        # Second server times out
        clients[1].get = AsyncMock(side_effect=httpx.TimeoutException("Timeout"))
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert "timeout" in data["mcp_servers"]["test-server-2"]
    
    @pytest.mark.asyncio
    async def test_health_check_mcp_server_connection_error(self, mcp_service):
        """Test health check handles MCP server connection error."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager (healthy)
        mock_db_manager = Mock()
        mock_db_manager.health_check.return_value = True
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (one connection error)
        clients = list(mcp_service.mcp_clients.values())
        
        # First server healthy
        mock_response_1 = Mock()
        mock_response_1.status_code = 200
        clients[0].get = AsyncMock(return_value=mock_response_1)
        
        # Second server connection error
        clients[1].get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert "connection_failed" in data["mcp_servers"]["test-server-2"]
    
    @pytest.mark.asyncio
    async def test_health_check_without_db(self, mcp_service):
        """Test health check when no database configured."""
        from fastapi.testclient import TestClient
        
        # No database connection manager
        mcp_service.db_connection_manager = None
        
        # Mock MCP server health checks (all healthy)
        for client in mcp_service.mcp_clients.values():
            mock_response = Mock()
            mock_response.status_code = 200
            client.get = AsyncMock(return_value=mock_response)
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["mcp_servers"]["database"] == "not_configured"
        assert data["mcp_servers"]["test-server-1"] == "healthy"
        assert data["mcp_servers"]["test-server-2"] == "healthy"
    
    @pytest.mark.asyncio
    async def test_health_check_db_exception(self, mcp_service):
        """Test health check handles database exceptions gracefully."""
        from fastapi.testclient import TestClient
        
        # Mock database connection manager that raises exception
        mock_db_manager = Mock()
        mock_db_manager.health_check.side_effect = Exception("Connection failed")
        mcp_service.db_connection_manager = mock_db_manager
        
        # Mock MCP server health checks (all healthy)
        for client in mcp_service.mcp_clients.values():
            mock_response = Mock()
            mock_response.status_code = 200
            client.get = AsyncMock(return_value=mock_response)
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert "Exception" in data["mcp_servers"]["database"]
