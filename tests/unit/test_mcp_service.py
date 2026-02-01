"""
Unit tests for MCP Adapter Standalone Service.

Tests the MCPAdapterService HTTP API for tool calls and resource reads.
"""

import pytest
from decimal import Decimal
from unittest.mock import Mock, AsyncMock, patch
from uuid import uuid4

from caracal.mcp.service import (
    MCPAdapterService,
    MCPServiceConfig,
    MCPServerConfig,
    ToolCallRequest,
    ResourceReadRequest,
    load_config_from_env,
)
from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.core.policy import PolicyEvaluator, PolicyDecision
from caracal.core.metering import MeteringCollector
from caracal.exceptions import BudgetExceededError


@pytest.fixture
def mcp_service_config():
    """Create test MCP service configuration."""
    return MCPServiceConfig(
        listen_address="0.0.0.0:8080",
        mcp_servers=[
            MCPServerConfig(name="test-server", url="http://localhost:9000", timeout_seconds=30)
        ],
        request_timeout_seconds=30,
        max_request_size_mb=10,
        enable_health_check=True,
        health_check_path="/health"
    )


@pytest.fixture
def mock_policy_evaluator():
    """Create mock PolicyEvaluator."""
    evaluator = Mock(spec=PolicyEvaluator)
    evaluator.check_budget = Mock(return_value=PolicyDecision(
        allowed=True,
        reason="Within budget",
        remaining_budget=Decimal("99.50"),
        provisional_charge_id=str(uuid4())
    ))
    return evaluator


@pytest.fixture
def mock_metering_collector():
    """Create mock MeteringCollector."""
    collector = Mock(spec=MeteringCollector)
    collector.collect_event = Mock()
    return collector


@pytest.fixture
def mock_mcp_adapter():
    """Create mock MCPAdapter."""
    adapter = Mock(spec=MCPAdapter)
    
    # Mock intercept_tool_call
    async def mock_intercept_tool_call(tool_name, tool_args, mcp_context):
        return MCPResult(
            success=True,
            result={"status": "success", "data": "test result"},
            error=None,
            metadata={
                "estimated_cost": "0.001",
                "actual_cost": "0.001",
                "provisional_charge_id": str(uuid4()),
                "remaining_budget": "99.50"
            }
        )
    
    adapter.intercept_tool_call = AsyncMock(side_effect=mock_intercept_tool_call)
    
    # Mock intercept_resource_read
    async def mock_intercept_resource_read(resource_uri, mcp_context):
        return MCPResult(
            success=True,
            result={
                "uri": resource_uri,
                "content": "test content",
                "mime_type": "text/plain",
                "size": 100
            },
            error=None,
            metadata={
                "estimated_cost": "0.002",
                "actual_cost": "0.002",
                "provisional_charge_id": str(uuid4()),
                "remaining_budget": "99.48",
                "resource_size": 100
            }
        )
    
    adapter.intercept_resource_read = AsyncMock(side_effect=mock_intercept_resource_read)
    
    return adapter


@pytest.fixture
def mcp_service(mcp_service_config, mock_mcp_adapter, mock_policy_evaluator, mock_metering_collector):
    """Create MCPAdapterService instance for testing."""
    return MCPAdapterService(
        config=mcp_service_config,
        mcp_adapter=mock_mcp_adapter,
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector
    )


class TestMCPAdapterService:
    """Test suite for MCPAdapterService."""
    
    def test_service_initialization(self, mcp_service, mcp_service_config):
        """Test service initialization."""
        assert mcp_service.config == mcp_service_config
        assert mcp_service.mcp_adapter is not None
        assert mcp_service.policy_evaluator is not None
        assert mcp_service.metering_collector is not None
        assert mcp_service.app is not None
        assert len(mcp_service.mcp_clients) == 1
        assert "test-server" in mcp_service.mcp_clients
    
    @pytest.mark.asyncio
    async def test_health_check_endpoint(self, mcp_service):
        """Test health check endpoint."""
        from fastapi.testclient import TestClient
        
        client = TestClient(mcp_service.app)
        response = client.get("/health")
        
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "caracal-mcp-adapter"
        assert data["version"] == "0.2.0"
        assert "status" in data
        assert "mcp_servers" in data
    
    @pytest.mark.asyncio
    async def test_stats_endpoint(self, mcp_service):
        """Test stats endpoint."""
        from fastapi.testclient import TestClient
        
        client = TestClient(mcp_service.app)
        response = client.get("/stats")
        
        assert response.status_code == 200
        data = response.json()
        assert "requests_total" in data
        assert "tool_calls_total" in data
        assert "resource_reads_total" in data
        assert "requests_allowed" in data
        assert "requests_denied" in data
        assert "errors_total" in data
        assert "mcp_servers" in data
    
    @pytest.mark.asyncio
    async def test_tool_call_endpoint_success(self, mcp_service, mock_mcp_adapter):
        """Test successful tool call endpoint."""
        from fastapi.testclient import TestClient
        
        client = TestClient(mcp_service.app)
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {"param1": "value1"},
            "agent_id": str(uuid4()),
            "metadata": {"request_id": "req-123"}
        }
        
        response = client.post("/mcp/tool/call", json=request_data)
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["result"] is not None
        assert data["error"] is None
        assert "metadata" in data
        
        # Verify adapter was called
        mock_mcp_adapter.intercept_tool_call.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_tool_call_endpoint_budget_exceeded(self, mcp_service, mock_mcp_adapter):
        """Test tool call endpoint with budget exceeded."""
        from fastapi.testclient import TestClient
        
        # Configure adapter to raise BudgetExceededError
        async def mock_budget_exceeded(*args, **kwargs):
            raise BudgetExceededError("Insufficient budget")
        
        mock_mcp_adapter.intercept_tool_call = AsyncMock(side_effect=mock_budget_exceeded)
        
        client = TestClient(mcp_service.app)
        
        request_data = {
            "tool_name": "test_tool",
            "tool_args": {"param1": "value1"},
            "agent_id": str(uuid4()),
            "metadata": {}
        }
        
        response = client.post("/mcp/tool/call", json=request_data)
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["result"] is None
        assert "Budget exceeded" in data["error"]
        assert data["metadata"]["error_type"] == "budget_exceeded"
    
    @pytest.mark.asyncio
    async def test_resource_read_endpoint_success(self, mcp_service, mock_mcp_adapter):
        """Test successful resource read endpoint."""
        from fastapi.testclient import TestClient
        
        client = TestClient(mcp_service.app)
        
        request_data = {
            "resource_uri": "file:///test/resource.txt",
            "agent_id": str(uuid4()),
            "metadata": {"request_id": "req-124"}
        }
        
        response = client.post("/mcp/resource/read", json=request_data)
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["result"] is not None
        assert data["error"] is None
        assert "metadata" in data
        
        # Verify adapter was called
        mock_mcp_adapter.intercept_resource_read.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_resource_read_endpoint_budget_exceeded(self, mcp_service, mock_mcp_adapter):
        """Test resource read endpoint with budget exceeded."""
        from fastapi.testclient import TestClient
        
        # Configure adapter to raise BudgetExceededError
        async def mock_budget_exceeded(*args, **kwargs):
            raise BudgetExceededError("Insufficient budget")
        
        mock_mcp_adapter.intercept_resource_read = AsyncMock(side_effect=mock_budget_exceeded)
        
        client = TestClient(mcp_service.app)
        
        request_data = {
            "resource_uri": "file:///test/resource.txt",
            "agent_id": str(uuid4()),
            "metadata": {}
        }
        
        response = client.post("/mcp/resource/read", json=request_data)
        
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["result"] is None
        assert "Budget exceeded" in data["error"]
        assert data["metadata"]["error_type"] == "budget_exceeded"


class TestMCPServiceConfig:
    """Test suite for MCP service configuration."""
    
    def test_config_initialization(self):
        """Test configuration initialization."""
        config = MCPServiceConfig(
            listen_address="0.0.0.0:8080",
            mcp_servers=[
                MCPServerConfig(name="server1", url="http://localhost:9000")
            ]
        )
        
        assert config.listen_address == "0.0.0.0:8080"
        assert len(config.mcp_servers) == 1
        assert config.mcp_servers[0].name == "server1"
        assert config.request_timeout_seconds == 30
        assert config.enable_health_check is True
    
    def test_config_defaults(self):
        """Test configuration defaults."""
        config = MCPServiceConfig()
        
        assert config.listen_address == "0.0.0.0:8080"
        assert config.mcp_servers == []
        assert config.request_timeout_seconds == 30
        assert config.max_request_size_mb == 10
        assert config.enable_health_check is True
        assert config.health_check_path == "/health"
    
    def test_load_config_from_env(self):
        """Test loading configuration from environment variables."""
        import os
        import json
        
        # Set environment variables
        os.environ['CARACAL_MCP_LISTEN_ADDRESS'] = '0.0.0.0:9090'
        os.environ['CARACAL_MCP_SERVERS'] = json.dumps([
            {"name": "test", "url": "http://localhost:9000", "timeout_seconds": 60}
        ])
        os.environ['CARACAL_MCP_REQUEST_TIMEOUT'] = '60'
        os.environ['CARACAL_MCP_MAX_REQUEST_SIZE_MB'] = '20'
        
        try:
            config = load_config_from_env()
            
            assert config.listen_address == '0.0.0.0:9090'
            assert len(config.mcp_servers) == 1
            assert config.mcp_servers[0].name == "test"
            assert config.mcp_servers[0].url == "http://localhost:9000"
            assert config.mcp_servers[0].timeout_seconds == 60
            assert config.request_timeout_seconds == 60
            assert config.max_request_size_mb == 20
        finally:
            # Clean up environment variables
            del os.environ['CARACAL_MCP_LISTEN_ADDRESS']
            del os.environ['CARACAL_MCP_SERVERS']
            del os.environ['CARACAL_MCP_REQUEST_TIMEOUT']
            del os.environ['CARACAL_MCP_MAX_REQUEST_SIZE_MB']


class TestMCPServerConfig:
    """Test suite for MCP server configuration."""
    
    def test_server_config_initialization(self):
        """Test server configuration initialization."""
        config = MCPServerConfig(
            name="test-server",
            url="http://localhost:9000",
            timeout_seconds=30
        )
        
        assert config.name == "test-server"
        assert config.url == "http://localhost:9000"
        assert config.timeout_seconds == 30
    
    def test_server_config_defaults(self):
        """Test server configuration defaults."""
        config = MCPServerConfig(
            name="test-server",
            url="http://localhost:9000"
        )
        
        assert config.timeout_seconds == 30
