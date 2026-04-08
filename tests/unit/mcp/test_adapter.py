"""
Unit tests for MCP adapter.

This module tests the Model Context Protocol adapter functionality.
"""
import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch, AsyncMock
from uuid import uuid4

from caracal.mcp.adapter import (
    MCPAdapter,
    MCPContext,
    MCPResource,
    MCPResult,
)
from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.core.metering import MeteringCollector
from caracal.db.models import ExecutionMandate
from caracal.exceptions import CaracalError


@pytest.mark.unit
class TestMCPContext:
    """Test suite for MCPContext dataclass."""
    
    def test_mcp_context_creation(self):
        """Test MCPContext creation."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={"key": "value", "mandate_id": "mandate-456"}
        )
        
        assert context.principal_id == "agent-123"
        assert context.metadata["key"] == "value"
    
    def test_mcp_context_get(self):
        """Test MCPContext.get method."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={"key": "value"}
        )
        
        assert context.get("key") == "value"
        assert context.get("nonexistent") is None
        assert context.get("nonexistent", "default") == "default"


@pytest.mark.unit
class TestMCPResource:
    """Test suite for MCPResource dataclass."""
    
    def test_mcp_resource_creation(self):
        """Test MCPResource creation."""
        resource = MCPResource(
            uri="file://test.txt",
            content="test content",
            mime_type="text/plain",
            size=12
        )
        
        assert resource.uri == "file://test.txt"
        assert resource.content == "test content"
        assert resource.mime_type == "text/plain"
        assert resource.size == 12


@pytest.mark.unit
class TestMCPResult:
    """Test suite for MCPResult dataclass."""
    
    def test_mcp_result_success(self):
        """Test MCPResult for successful operation."""
        result = MCPResult(
            success=True,
            result={"output": "test"},
            error=None,
            metadata={"mandate_id": "mandate-123"}
        )
        
        assert result.success is True
        assert result.result["output"] == "test"
        assert result.error is None
    
    def test_mcp_result_failure(self):
        """Test MCPResult for failed operation."""
        result = MCPResult(
            success=False,
            result=None,
            error="Authority denied"
        )
        
        assert result.success is False
        assert result.result is None
        assert "denied" in result.error.lower()


@pytest.mark.unit
class TestMCPAdapter:
    """Test suite for MCP adapter."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_authority_evaluator = Mock(spec=AuthorityEvaluator)
        self.mock_metering_collector = Mock(spec=MeteringCollector)
        
        self.adapter = MCPAdapter(
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            mcp_server_url="http://localhost:3001",
            request_timeout_seconds=30
        )
    
    def test_adapter_initialization(self):
        """Test MCP adapter initialization."""
        assert self.adapter.authority_evaluator == self.mock_authority_evaluator
        assert self.adapter.metering_collector == self.mock_metering_collector
        assert self.adapter.mcp_server_url == "http://localhost:3001"
        assert self.adapter.request_timeout_seconds == 30

    def test_adapter_rejects_invalid_caveat_mode(self):
        """Test adapter initialization fails on unsupported caveat modes."""
        with pytest.raises(CaracalError, match="Invalid caveat mode"):
            MCPAdapter(
                authority_evaluator=self.mock_authority_evaluator,
                metering_collector=self.mock_metering_collector,
                caveat_mode="invalid-mode",
            )
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_missing_mandate_id(self):
        """Test tool call interception with missing mandate_id."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={}  # No mandate_id
        )
        
        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context
        )
        
        assert result.success is False
        assert "mandate_id" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_invalid_mandate_id(self):
        """Test tool call interception with invalid mandate_id format."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": "invalid-uuid"}
        )
        
        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context
        )
        
        assert result.success is False
        assert "invalid" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_mandate_not_found(self):
        """Test tool call interception with non-existent mandate."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )
        
        # Mock mandate not found
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = None
        
        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context
        )
        
        assert result.success is False
        assert "not found" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_authority_denied(self):
        """Test tool call interception with authority denied."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )
        
        # Mock mandate found
        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        
        # Mock authority denied
        mock_decision = AuthorityDecision(
            allowed=False,
            reason="Insufficient permissions",
            mandate_id=mandate_id,
            requested_action="execute",
            requested_resource="test_tool"
        )
        self.mock_authority_evaluator.validate_mandate.return_value = mock_decision
        
        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context
        )
        
        assert result.success is False
        assert "denied" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_success(self):
        """Test successful tool call interception."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )
        
        # Mock mandate found
        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        
        # Mock authority granted
        mock_decision = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="execute",
            requested_resource="test_tool"
        )
        self.mock_authority_evaluator.validate_mandate.return_value = mock_decision
        
        # Mock tool execution
        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"output": "test result"}
            
            result = await self.adapter.intercept_tool_call(
                tool_name="test_tool",
                tool_args={"arg": "value"},
                mcp_context=context
            )
        
        assert result.success is True
        assert result.result["output"] == "test result"
        self.mock_metering_collector.collect_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_intercept_tool_call_caveat_chain_mode_forwards_chain_inputs(self):
        """Test caveat-chain mode forwards chain data into authority checks."""
        adapter = MCPAdapter(
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            mcp_server_url="http://localhost:3001",
            caveat_mode="caveat_chain",
            caveat_hmac_key="global-chain-key",
        )

        mandate_id = uuid4()
        task_chain = [{"index": 0, "type": "action", "value": "execute", "hmac": "abc", "previous_hmac": ""}]
        context = MCPContext(
            principal_id="agent-123",
            metadata={
                "mandate_id": str(mandate_id),
                "task_caveat_chain": task_chain,
                "task_id": "task-xyz",
            },
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="execute",
            requested_resource="test_tool",
        )

        with patch.object(adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"output": "ok"}
            result = await adapter.intercept_tool_call(
                tool_name="test_tool",
                tool_args={"arg": "value"},
                mcp_context=context,
            )

        assert result.success is True
        call_kwargs = self.mock_authority_evaluator.validate_mandate.call_args.kwargs
        assert call_kwargs["caveat_chain"] == task_chain
        assert call_kwargs["caveat_hmac_key"] == "global-chain-key"
        assert call_kwargs["caveat_task_id"] == "task-xyz"

    @pytest.mark.asyncio
    async def test_intercept_tool_call_jwt_mode_ignores_caveat_chain_metadata(self):
        """Test JWT mode does not pass caveat-chain kwargs into authority checks."""
        adapter = MCPAdapter(
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            mcp_server_url="http://localhost:3001",
            caveat_mode="jwt",
        )

        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={
                "mandate_id": str(mandate_id),
                "task_caveat_chain": [{"index": 0, "type": "action", "value": "execute"}],
                "task_id": "task-xyz",
            },
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="execute",
            requested_resource="test_tool",
        )

        with patch.object(adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"output": "ok"}
            result = await adapter.intercept_tool_call(
                tool_name="test_tool",
                tool_args={"arg": "value"},
                mcp_context=context,
            )

        assert result.success is True
        call_kwargs = self.mock_authority_evaluator.validate_mandate.call_args.kwargs
        assert "caveat_chain" not in call_kwargs
        assert "caveat_hmac_key" not in call_kwargs
        assert "caveat_task_id" not in call_kwargs
    
    @pytest.mark.asyncio
    async def test_intercept_resource_read_missing_mandate_id(self):
        """Test resource read interception with missing mandate_id."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={}  # No mandate_id
        )
        
        result = await self.adapter.intercept_resource_read(
            resource_uri="file://test.txt",
            mcp_context=context
        )
        
        assert result.success is False
        assert "mandate_id" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_resource_read_authority_denied(self):
        """Test resource read interception with authority denied."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )
        
        # Mock mandate found
        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        
        # Mock authority denied
        mock_decision = AuthorityDecision(
            allowed=False,
            reason="Insufficient permissions",
            mandate_id=mandate_id,
            requested_action="read",
            requested_resource="file://test.txt"
        )
        self.mock_authority_evaluator.validate_mandate.return_value = mock_decision
        
        result = await self.adapter.intercept_resource_read(
            resource_uri="file://test.txt",
            mcp_context=context
        )
        
        assert result.success is False
        assert "denied" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_intercept_resource_read_success(self):
        """Test successful resource read interception."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )
        
        # Mock mandate found
        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate
        
        # Mock authority granted
        mock_decision = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="read",
            requested_resource="file://test.txt"
        )
        self.mock_authority_evaluator.validate_mandate.return_value = mock_decision
        
        # Mock resource fetch
        mock_resource = MCPResource(
            uri="file://test.txt",
            content="test content",
            mime_type="text/plain",
            size=12
        )
        with patch.object(self.adapter, "_fetch_resource", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = mock_resource
            
            result = await self.adapter.intercept_resource_read(
                resource_uri="file://test.txt",
                mcp_context=context
            )
        
        assert result.success is True
        assert result.result.content == "test content"
        self.mock_metering_collector.collect_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_intercept_tool_call_denies_mandate_subject_mismatch(self):
        """Test tool call interception denies when caller is not mandate subject."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "different-agent"
        self.mock_authority_evaluator._get_mandate_with_cache.return_value = mock_mandate

        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context,
        )

        assert result.success is False
        assert "does not match mandate subject" in result.error.lower()
        self.mock_authority_evaluator.validate_mandate.assert_not_called()
    
    def test_extract_principal_id_success(self):
        """Test successful principal ID extraction."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={}
        )
        
        principal_id = self.adapter._extract_principal_id(context)
        assert principal_id == "agent-123"
    
    def test_extract_principal_id_missing(self):
        """Test principal ID extraction with missing ID."""
        context = MCPContext(
            principal_id="",
            metadata={}
        )
        
        with pytest.raises(CaracalError):
            self.adapter._extract_principal_id(context)
    
    def test_get_resource_type_file(self):
        """Test resource type extraction for file URI."""
        resource_type = self.adapter._get_resource_type("file://test.txt")
        assert resource_type == "file"
    
    def test_get_resource_type_http(self):
        """Test resource type extraction for HTTP URI."""
        resource_type = self.adapter._get_resource_type("http://example.com/resource")
        assert resource_type == "http"
    
    def test_get_resource_type_https(self):
        """Test resource type extraction for HTTPS URI."""
        resource_type = self.adapter._get_resource_type("https://example.com/resource")
        assert resource_type == "http"
    
    def test_get_resource_type_s3(self):
        """Test resource type extraction for S3 URI."""
        resource_type = self.adapter._get_resource_type("s3://bucket/key")
        assert resource_type == "s3"
    
    def test_get_resource_type_unknown(self):
        """Test resource type extraction for unknown URI."""
        resource_type = self.adapter._get_resource_type("unknown://resource")
        assert resource_type == "unknown"
