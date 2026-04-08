"""
Unit tests for MCP adapter service.

This module tests the MCPAdapterService class and HTTP API.
"""
import pytest
from unittest.mock import Mock, MagicMock, patch, AsyncMock
from uuid import uuid4

from caracal.mcp.service import (
    MCPAdapterService,
    MCPServiceConfig,
    MCPServerConfig,
    ToolCallRequest,
    ResourceReadRequest,
    MCPServiceResponse,
    HealthCheckResponse,
)
from caracal.mcp.adapter import MCPAdapter, MCPResult, MCPResource
from caracal.core.authority import AuthorityEvaluator
from caracal.core.metering import MeteringCollector
from caracal.exceptions import CaracalError


@pytest.mark.unit
class TestMCPServerConfig:
    """Test suite for MCPServerConfig dataclass."""
    
    def test_mcp_server_config_creation(self):
        """Test MCPServerConfig creation."""
        config = MCPServerConfig(
            name="test-server",
            url="http://localhost:3001",
            timeout_seconds=30
        )
        
        assert config.name == "test-server"
        assert config.url == "http://localhost:3001"
        assert config.timeout_seconds == 30
    
    def test_mcp_server_config_default_timeout(self):
        """Test MCPServerConfig with default timeout."""
        config = MCPServerConfig(
            name="test-server",
            url="http://localhost:3001"
        )
        
        assert config.timeout_seconds == 30


@pytest.mark.unit
class TestMCPServiceConfig:
    """Test suite for MCPServiceConfig dataclass."""
    
    def test_mcp_service_config_creation(self):
        """Test MCPServiceConfig creation."""
        server_config = MCPServerConfig(
            name="test-server",
            url="http://localhost:3001"
        )
        
        config = MCPServiceConfig(
            listen_address="0.0.0.0:8080",
            mcp_servers=[server_config],
            request_timeout_seconds=30,
            max_request_size_mb=10,
            enable_health_check=True,
            health_check_path="/health",
            log_level="info"
        )
        
        assert config.listen_address == "0.0.0.0:8080"
        assert len(config.mcp_servers) == 1
        assert config.request_timeout_seconds == 30
        assert config.enable_health_check is True
    
    def test_mcp_service_config_defaults(self):
        """Test MCPServiceConfig with default values."""
        config = MCPServiceConfig()
        
        assert config.listen_address == "0.0.0.0:8080"
        assert config.mcp_servers == []
        assert config.request_timeout_seconds == 30
        assert config.max_request_size_mb == 10
        assert config.enable_health_check is True
        assert config.health_check_path == "/health"
        assert config.log_level == "info"


@pytest.mark.unit
class TestToolCallRequest:
    """Test suite for ToolCallRequest model."""
    
    def test_tool_call_request_creation(self):
        """Test ToolCallRequest creation."""
        request = ToolCallRequest(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            metadata={"key": "value"}
        )
        
        assert request.tool_name == "test_tool"
        assert request.tool_args["arg"] == "value"
        assert request.metadata["key"] == "value"
    
    def test_tool_call_request_defaults(self):
        """Test ToolCallRequest with default values."""
        request = ToolCallRequest(
            tool_name="test_tool"
        )
        
        assert request.tool_args == {}
        assert request.metadata == {}


@pytest.mark.unit
class TestResourceReadRequest:
    """Test suite for ResourceReadRequest model."""
    
    def test_resource_read_request_creation(self):
        """Test ResourceReadRequest creation."""
        request = ResourceReadRequest(
            resource_uri="file://test.txt",
            metadata={"key": "value"}
        )
        
        assert request.resource_uri == "file://test.txt"
        assert request.metadata["key"] == "value"


@pytest.mark.unit
class TestMCPServiceResponse:
    """Test suite for MCPServiceResponse model."""
    
    def test_mcp_service_response_success(self):
        """Test MCPServiceResponse for successful operation."""
        response = MCPServiceResponse(
            success=True,
            result={"output": "test"},
            error=None,
            metadata={"mandate_id": "mandate-123"}
        )
        
        assert response.success is True
        assert response.result["output"] == "test"
        assert response.error is None
    
    def test_mcp_service_response_failure(self):
        """Test MCPServiceResponse for failed operation."""
        response = MCPServiceResponse(
            success=False,
            result=None,
            error="Authority denied"
        )
        
        assert response.success is False
        assert response.result is None
        assert "denied" in response.error.lower()


@pytest.mark.unit
class TestHealthCheckResponse:
    """Test suite for HealthCheckResponse model."""
    
    def test_health_check_response_creation(self):
        """Test HealthCheckResponse creation."""
        response = HealthCheckResponse(
            status="healthy",
            service="caracal-mcp-adapter",
            version="0.3.0",
            mcp_servers={"server1": "healthy", "database": "healthy"}
        )
        
        assert response.status == "healthy"
        assert response.service == "caracal-mcp-adapter"
        assert response.version == "0.3.0"
        assert response.mcp_servers["server1"] == "healthy"


@pytest.mark.unit
class TestMCPAdapterService:
    """Test suite for MCP adapter service."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_mcp_adapter = Mock(spec=MCPAdapter)
        self.mock_authority_evaluator = Mock(spec=AuthorityEvaluator)
        self.mock_metering_collector = Mock(spec=MeteringCollector)
        self.mock_db_connection_manager = Mock()
        self.mock_session_manager = Mock()
        self.mock_session_manager.validate_access_token = AsyncMock(
            return_value={"sub": "agent-123"}
        )
        
        # Create server config
        server_config = MCPServerConfig(
            name="test-server",
            url="http://localhost:3001"
        )
        
        self.config = MCPServiceConfig(
            listen_address="0.0.0.0:8080",
            mcp_servers=[server_config]
        )
        
        self.service = MCPAdapterService(
            config=self.config,
            mcp_adapter=self.mock_mcp_adapter,
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            db_connection_manager=self.mock_db_connection_manager,
            session_manager=self.mock_session_manager,
        )
    
    def test_service_initialization(self):
        """Test MCP adapter service initialization."""
        assert self.service.config == self.config
        assert self.service.mcp_adapter == self.mock_mcp_adapter
        assert self.service.authority_evaluator == self.mock_authority_evaluator
        assert self.service.metering_collector == self.mock_metering_collector
        assert self.service.app is not None
    
    def test_service_statistics_initialization(self):
        """Test service statistics are initialized to zero."""
        assert self.service._request_count == 0
        assert self.service._tool_call_count == 0
        assert self.service._resource_read_count == 0
        assert self.service._allowed_count == 0
        assert self.service._denied_count == 0
        assert self.service._error_count == 0
    
    @pytest.mark.asyncio
    async def test_health_check_all_healthy(self):
        """Test health check endpoint with all services healthy."""
        # Mock database health check
        self.mock_db_connection_manager.health_check.return_value = True
        
        # Mock MCP server health check
        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_response = AsyncMock()
            mock_response.status_code = 200
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client_class.return_value = mock_client
            
            # Get health check route
            from fastapi.testclient import TestClient
            client = TestClient(self.service.app)
            
            # Mock the MCP clients
            self.service.mcp_clients = {"test-server": mock_client}
            
            response = client.get("/health")
            
            assert response.status_code == 200
            data = response.json()
            assert data["status"] == "healthy"
            assert data["service"] == "caracal-mcp-adapter"
    
    @pytest.mark.asyncio
    async def test_health_check_degraded(self):
        """Test health check endpoint with degraded services."""
        # Mock database health check failure
        self.mock_db_connection_manager.health_check.return_value = False
        
        # Get health check route
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock the MCP clients
        mock_client = AsyncMock()
        self.service.mcp_clients = {"test-server": mock_client}
        
        response = client.get("/health")
        
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
    
    def test_stats_endpoint(self):
        """Test stats endpoint."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Set some statistics
        self.service._request_count = 10
        self.service._tool_call_count = 5
        self.service._resource_read_count = 3
        
        response = client.get("/stats")
        
        assert response.status_code == 200
        data = response.json()
        assert data["requests_total"] == 10
        assert data["tool_calls_total"] == 5
        assert data["resource_reads_total"] == 3
    
    @pytest.mark.asyncio
    async def test_tool_call_endpoint_success(self):
        """Test tool call endpoint with successful execution."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock successful tool call
        mock_result = MCPResult(
            success=True,
            result={"output": "test result"},
            error=None,
            metadata={"mandate_id": "mandate-123"}
        )
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(return_value=mock_result)
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {"arg": "value"},
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["result"]["output"] == "test result"
    
    @pytest.mark.asyncio
    async def test_tool_call_endpoint_authority_denied(self):
        """Test tool call endpoint with authority denied."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock authority denied
        mock_result = MCPResult(
            success=False,
            result=None,
            error="Authority denied: Insufficient permissions"
        )
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(return_value=mock_result)
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {"arg": "value"},
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "denied" in data["error"].lower()
    
    @pytest.mark.asyncio
    async def test_tool_call_endpoint_error(self):
        """Test tool call endpoint with error."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock error
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(
            side_effect=CaracalError("Test error")
        )
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {"arg": "value"},
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "error" in data["error"].lower()
    
    @pytest.mark.asyncio
    async def test_resource_read_endpoint_success(self):
        """Test resource read endpoint with successful execution."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock successful resource read
        mock_resource = MCPResource(
            uri="file://test.txt",
            content="test content",
            mime_type="text/plain",
            size=12
        )
        mock_result = MCPResult(
            success=True,
            result=mock_resource,
            error=None,
            metadata={"resource_size": 12}
        )
        self.mock_mcp_adapter.intercept_resource_read = AsyncMock(return_value=mock_result)
        
        request_data = {
            "resource_uri": "file://test.txt",
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        response = client.post(
            "/mcp/resource/read",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
    
    @pytest.mark.asyncio
    async def test_resource_read_endpoint_authority_denied(self):
        """Test resource read endpoint with authority denied."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock authority denied
        mock_result = MCPResult(
            success=False,
            result=None,
            error="Authority denied: Insufficient permissions"
        )
        self.mock_mcp_adapter.intercept_resource_read = AsyncMock(return_value=mock_result)
        
        request_data = {
            "resource_uri": "file://test.txt",
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        response = client.post(
            "/mcp/resource/read",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "denied" in data["error"].lower()
    
    def test_service_statistics_increment(self):
        """Test that service statistics are incremented correctly."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)
        
        # Mock successful tool call
        mock_result = MCPResult(
            success=True,
            result={"output": "test"},
            error=None
        )
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(return_value=mock_result)
        
        initial_count = self.service._request_count
        initial_tool_count = self.service._tool_call_count
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {},
            "metadata": {"mandate_id": str(uuid4())}
        }
        
        client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )
        
        assert self.service._request_count == initial_count + 1
        assert self.service._tool_call_count == initial_tool_count + 1

    def test_tool_call_endpoint_missing_authorization_header(self):
        """Test tool call endpoint denies unauthenticated requests."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        request_data = {
            "tool_name": "test_tool",
            "tool_args": {},
            "metadata": {"mandate_id": str(uuid4())}
        }

        response = client.post("/mcp/tool/call", json=request_data)

        assert response.status_code == 401
        assert "authorization" in response.json()["detail"].lower()

    def test_tool_call_endpoint_invalid_mandate_id(self):
        """Test tool call endpoint rejects malformed mandate IDs before adapter call."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        request_data = {
            "tool_name": "test_tool",
            "tool_args": {},
            "metadata": {"mandate_id": "not-a-uuid"}
        }

        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "mandate_id" in response.json()["detail"].lower()

    def test_tool_call_endpoint_missing_mandate_id(self):
        """Test tool call endpoint rejects missing mandate ID metadata."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        request_data = {
            "tool_name": "test_tool",
            "tool_args": {},
            "metadata": {}
        }

        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "mandate_id" in response.json()["detail"].lower()
