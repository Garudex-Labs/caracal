"""
Unit tests for MCP adapter service.

This module tests the MCPAdapterService class and HTTP API.
"""
import pytest
from unittest.mock import Mock, MagicMock, patch, AsyncMock
from types import SimpleNamespace
from uuid import uuid4

from caracal.mcp.service import (
    MCPAdapterService,
    MCPServiceConfig,
    MCPServerConfig,
    ToolCallRequest,
    ResourceReadRequest,
    MCPServiceResponse,
    HealthCheckResponse,
    _validate_active_tool_mapping_bindings,
    _validate_forward_tool_server_bindings,
)
from caracal.mcp.adapter import MCPAdapter, MCPResult, MCPResource
from caracal.core.authority import AuthorityEvaluator
from caracal.core.metering import MeteringCollector
from caracal.exceptions import CaracalError, MCPUnknownMandateError, MCPUnknownToolError


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
            tool_id="test_tool",
            mandate_id=str(uuid4()),
            tool_args={"arg": "value"},
            metadata={"key": "value"}
        )

        assert request.tool_id == "test_tool"
        assert request.mandate_id
        assert request.tool_args["arg"] == "value"
        assert request.metadata["key"] == "value"
    
    def test_tool_call_request_defaults(self):
        """Test ToolCallRequest with default values."""
        request = ToolCallRequest(
            tool_id="test_tool",
            mandate_id=str(uuid4()),
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
        self.actor_principal_id = "11111111-1111-1111-1111-111111111111"
        self.mock_mcp_adapter = Mock(spec=MCPAdapter)
        self.mock_authority_evaluator = Mock(spec=AuthorityEvaluator)
        self.mock_metering_collector = Mock(spec=MeteringCollector)
        self.mock_db_connection_manager = Mock()
        self.mock_session_manager = Mock()
        self.mock_session_manager.validate_access_token = AsyncMock(
            return_value={"sub": self.actor_principal_id}
        )
        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=True,
        )
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = SimpleNamespace(
            revoked=False,
            valid_until=None,
            subject_id=self.actor_principal_id,
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

    @pytest.mark.unit
    def test_validate_forward_tool_server_bindings_rejects_unknown_named_targets(self):
        class _Query:
            def __init__(self, rows):
                self._rows = rows

            def filter_by(self, **kwargs):
                rows = [
                    row for row in self._rows
                    if all(getattr(row, key, None) == value for key, value in kwargs.items())
                ]
                return _Query(rows)

            def all(self):
                return list(self._rows)

        class _Session:
            def __init__(self, rows):
                self._rows = rows

            def query(self, _model):
                return _Query(self._rows)

        session = _Session(
            [
                SimpleNamespace(
                    tool_id="tool.forward",
                    active=True,
                    execution_mode="mcp_forward",
                    mcp_server_name="missing-server",
                )
            ]
        )

        with pytest.raises(RuntimeError, match="unresolved MCP server targets"):
            _validate_forward_tool_server_bindings(
                session,
                named_server_urls={"server-0": "http://localhost:3001"},
            )


    @pytest.mark.unit
    def test_validate_forward_tool_server_bindings_accepts_known_named_targets(self):
        class _Query:
            def __init__(self, rows):
                self._rows = rows

            def filter_by(self, **kwargs):
                rows = [
                    row for row in self._rows
                    if all(getattr(row, key, None) == value for key, value in kwargs.items())
                ]
                return _Query(rows)

            def all(self):
                return list(self._rows)

        class _Session:
            def __init__(self, rows):
                self._rows = rows

            def query(self, _model):
                return _Query(self._rows)

        session = _Session(
            [
                SimpleNamespace(
                    tool_id="tool.forward",
                    active=True,
                    execution_mode="mcp_forward",
                    mcp_server_name="server-0",
                )
            ]
        )

        _validate_forward_tool_server_bindings(
            session,
            named_server_urls={"server-0": "http://localhost:3001"},
        )

    @pytest.mark.unit
    def test_validate_forward_tool_server_bindings_rejects_missing_default_target(self):
        class _Query:
            def __init__(self, rows):
                self._rows = rows

            def filter_by(self, **kwargs):
                rows = [
                    row for row in self._rows
                    if all(getattr(row, key, None) == value for key, value in kwargs.items())
                ]
                return _Query(rows)

            def all(self):
                return list(self._rows)

        class _Session:
            def __init__(self, rows):
                self._rows = rows

            def query(self, _model):
                return _Query(self._rows)

        session = _Session(
            [
                SimpleNamespace(
                    tool_id="tool.forward",
                    active=True,
                    execution_mode="mcp_forward",
                    mcp_server_name=None,
                )
            ]
        )

        with pytest.raises(RuntimeError, match="unresolved MCP server targets"):
            _validate_forward_tool_server_bindings(
                session,
                named_server_urls={},
                has_default_forward_target=False,
            )

    @pytest.mark.unit
    @patch("caracal.mcp.service.validate_active_tool_mappings")
    def test_validate_active_tool_mapping_bindings_raises_on_issues(self, mock_validate):
        mock_validate.return_value = [
            {
                "tool_id": "tool.bad",
                "check": "mapping",
                "message": "Provider mapping drift",
            }
        ]

        with pytest.raises(RuntimeError, match="Active tool mapping validation failed"):
            _validate_active_tool_mapping_bindings(
                Mock(),
                named_server_urls={"server-0": "http://localhost:3001"},
                has_default_forward_target=True,
            )
    
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

    def test_tool_registry_register_endpoint_success(self):
        """Tool registry register endpoint should return persisted record payload."""
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.register_tool.return_value = SimpleNamespace(
            tool_id="tool.echo",
            active=True,
        )

        response = client.post(
            "/mcp/tools/register",
            json={
                "tool_id": "tool.echo",
                "active": True,
                "provider_name": "endframe",
                "resource_scope": "provider:endframe:resource:deployments",
                "action_scope": "provider:endframe:action:invoke",
                "provider_definition_id": "endframe",
                "action_method": "POST",
                "action_path_prefix": "/v1/deployments",
                "execution_mode": "mcp_forward",
                "mcp_server_name": "server-0",
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["result"]["tool_id"] == "tool.echo"
        assert data["result"]["active"] is True
        self.mock_mcp_adapter.register_tool.assert_called_once_with(
            tool_id="tool.echo",
            active=True,
            actor_principal_id=self.actor_principal_id,
            provider_name="endframe",
            resource_scope="provider:endframe:resource:deployments",
            action_scope="provider:endframe:action:invoke",
            provider_definition_id="endframe",
            action_method="POST",
            action_path_prefix="/v1/deployments",
            execution_mode="mcp_forward",
            mcp_server_name="server-0",
            workspace_name=None,
            tool_type="direct_api",
            handler_ref=None,
            mapping_version=None,
            allowed_downstream_scopes=[],
        )

    def test_tool_registry_list_endpoint_success(self):
        """Tool registry list endpoint should include serialized rows."""
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.list_registered_tools.return_value = [
            SimpleNamespace(tool_id="tool.one", active=True),
            SimpleNamespace(tool_id="tool.two", active=False),
        ]

        response = client.get(
            "/mcp/tools?include_inactive=true",
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert len(data["result"]["tools"]) == 2
        assert data["result"]["tools"][0]["tool_id"] == "tool.one"
        self.mock_mcp_adapter.list_registered_tools.assert_called_once_with(include_inactive=True)

    def test_tool_registry_deactivate_and_reactivate_endpoints(self):
        """Deactivate/reactivate endpoints should call adapter lifecycle methods."""
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.deactivate_tool.return_value = SimpleNamespace(
            tool_id="tool.echo",
            active=False,
        )
        self.mock_mcp_adapter.reactivate_tool.return_value = SimpleNamespace(
            tool_id="tool.echo",
            active=True,
        )

        deactivate_response = client.post(
            "/mcp/tools/deactivate",
            json={"tool_id": "tool.echo"},
            headers={"Authorization": "Bearer test-token"},
        )
        reactivate_response = client.post(
            "/mcp/tools/reactivate",
            json={"tool_id": "tool.echo"},
            headers={"Authorization": "Bearer test-token"},
        )

        assert deactivate_response.status_code == 200
        assert reactivate_response.status_code == 200
        assert deactivate_response.json()["result"]["active"] is False
        assert reactivate_response.json()["result"]["active"] is True
        self.mock_mcp_adapter.deactivate_tool.assert_called_once_with(
            tool_id="tool.echo",
            actor_principal_id=self.actor_principal_id,
        )
        self.mock_mcp_adapter.reactivate_tool.assert_called_once_with(
            tool_id="tool.echo",
            actor_principal_id=self.actor_principal_id,
        )
    
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
        mandate_id = str(uuid4())
        
        request_data = {
            "tool_id": "test_tool",
            "mandate_id": mandate_id,
            "tool_args": {"arg": "value"},
            "metadata": {},
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
        mandate_id = str(uuid4())
        
        request_data = {
            "tool_id": "test_tool",
            "mandate_id": mandate_id,
            "tool_args": {"arg": "value"},
            "metadata": {},
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
        mandate_id = str(uuid4())
        
        request_data = {
            "tool_id": "test_tool",
            "mandate_id": mandate_id,
            "tool_args": {"arg": "value"},
            "metadata": {},
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
        mandate_id = str(uuid4())
        
        initial_count = self.service._request_count
        initial_tool_count = self.service._tool_call_count
        
        request_data = {
            "tool_id": "test_tool",
            "mandate_id": mandate_id,
            "tool_args": {},
            "metadata": {},
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
            "tool_id": "test_tool",
            "mandate_id": str(uuid4()),
            "tool_args": {},
            "metadata": {},
        }

        response = client.post("/mcp/tool/call", json=request_data)

        assert response.status_code == 401
        assert "authorization" in response.json()["detail"].lower()

    def test_tool_call_endpoint_invalid_mandate_id(self):
        """Test tool call endpoint rejects malformed mandate IDs before adapter call."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        request_data = {
            "tool_id": "test_tool",
            "mandate_id": "not-a-uuid",
            "tool_args": {},
            "metadata": {},
        }

        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "mandate_id" in response.json()["detail"].lower()

    def test_tool_call_endpoint_missing_mandate_id(self):
        """Test tool call endpoint rejects missing mandate ID payload."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        request_data = {
            "tool_id": "test_tool",
            "tool_args": {},
            "metadata": {}
        }

        response = client.post(
            "/mcp/tool/call",
            json=request_data,
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 422
        assert "mandate_id" in str(response.json()).lower()

    def test_tool_call_endpoint_unknown_tool_id(self):
        """Service layer should reject unknown tool IDs before adapter invocation."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        self.mock_mcp_adapter.get_registered_tool.return_value = None

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "missing.tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 404
        assert "unknown tool_id" in response.json()["detail"].lower()

    def test_tool_call_endpoint_rejects_provider_selector_body_header_mismatch(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=True,
            provider_name="endframe",
            provider_definition_id="endframe",
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {
                    "provider_name": "endframe",
                },
            },
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Provider-Name": "other-provider",
            },
        )

        assert response.status_code == 400
        assert "provider selector mismatch" in response.json()["detail"].lower()

    def test_tool_call_endpoint_maps_workspace_scope_header_into_canonical_metadata(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(
            return_value=MCPResult(success=True, result={"ok": True}, error=None)
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Workspace-ID": "ws-sdk",
            },
        )

        assert response.status_code == 200
        mcp_context = self.mock_mcp_adapter.intercept_tool_call.call_args.kwargs["mcp_context"]
        assert mcp_context.get("workspace") == "ws-sdk"
        assert mcp_context.get("workspace_name") == "ws-sdk"

    def test_tool_call_endpoint_rejects_workspace_scope_body_header_mismatch(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {
                    "workspace": "workspace-from-body",
                },
            },
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Workspace-ID": "workspace-from-header",
            },
        )

        assert response.status_code == 400
        assert "workspace selector mismatch" in response.json()["detail"].lower()
        self.mock_mcp_adapter.intercept_tool_call.assert_not_called()

    def test_tool_call_endpoint_rejects_provider_selector_mapped_tool_mismatch(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=True,
            provider_name="endframe",
            provider_definition_id="endframe",
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {
                    "provider_name": "anthropic",
                },
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "does not match mapped provider" in response.json()["detail"].lower()

    def test_tool_call_endpoint_returns_denied_when_adapter_rejects_subject_binding(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(
            return_value=MCPResult(
                success=False,
                result=None,
                error="Authority denied: Authenticated principal does not match mandate subject",
            )
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "does not match mandate subject" in data["error"].lower()
        assert self.service._denied_count == 1

    def test_tool_call_endpoint_counts_authority_denials_in_denied_counter(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.intercept_tool_call = AsyncMock(
            return_value=MCPResult(
                success=False,
                result=None,
                error="Authority denied: Missing mandate_id",
            )
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 200
        assert response.json()["success"] is False
        assert self.service._denied_count == 1
        assert self.service._error_count == 0

    def test_tool_call_endpoint_rejects_resource_scope_body_header_mismatch(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=True,
            provider_name="endframe",
            provider_definition_id="endframe",
            resource_scope="provider:endframe:resource:deployments",
            action_scope="provider:endframe:action:invoke",
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {
                    "resource_scope": "provider:endframe:resource:deployments",
                },
            },
            headers={
                "Authorization": "Bearer test-token",
                "X-Caracal-Resource-Scope": "provider:endframe:resource:pipelines",
            },
        )

        assert response.status_code == 400
        assert "resource scope selector mismatch" in response.json()["detail"].lower()

    def test_tool_call_endpoint_rejects_action_scope_mapped_tool_mismatch(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.service.app)
        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=True,
            provider_name="endframe",
            provider_definition_id="endframe",
            resource_scope="provider:endframe:resource:deployments",
            action_scope="provider:endframe:action:invoke",
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {
                    "action_scope": "provider:endframe:action:destroy",
                },
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "does not match mapped action scope" in response.json()["detail"].lower()

    def test_require_active_tool_raises_unknown_tool_error_class(self):
        """Unknown tools should raise deterministic MCPUnknownToolError."""
        self.mock_mcp_adapter.get_registered_tool.return_value = None

        with pytest.raises(MCPUnknownToolError, match="Unknown tool_id"):
            self.service._require_active_tool("missing.tool")

    def test_tool_call_endpoint_inactive_tool_id(self):
        """Service layer should reject inactive tools before adapter invocation."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        self.mock_mcp_adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id="test_tool",
            active=False,
        )

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 400
        assert "inactive" in response.json()["detail"].lower()

    def test_tool_call_endpoint_unknown_mandate_id(self):
        """Service layer should reject unknown mandates before adapter invocation."""
        from fastapi.testclient import TestClient
        client = TestClient(self.service.app)

        self.mock_authority_evaluator._get_mandate_with_cache.return_value = None

        response = client.post(
            "/mcp/tool/call",
            json={
                "tool_id": "test_tool",
                "mandate_id": str(uuid4()),
                "tool_args": {},
                "metadata": {},
            },
            headers={"Authorization": "Bearer test-token"},
        )

        assert response.status_code == 404
        assert "unknown mandate_id" in response.json()["detail"].lower()

    def test_require_active_mandate_raises_unknown_mandate_error_class(self):
        """Unknown mandates should raise deterministic MCPUnknownMandateError."""
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = None

        with pytest.raises(MCPUnknownMandateError, match="Unknown mandate_id"):
            self.service._require_active_mandate(str(uuid4()))
