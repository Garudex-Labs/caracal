"""
Unit tests for MCP adapter.

This module tests the Model Context Protocol adapter functionality.
"""
import pytest
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
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
from caracal.db.models import ExecutionMandate, GatewayProvider, RegisteredTool
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.exceptions import (
    CaracalError,
    MCPProviderMissingError,
    MCPToolMappingMismatchError,
    MCPUnknownToolError,
)


_TOOL_ID = "provider:endframe:resource:deployments"
_MAPPED_PROVIDER_NAME = "endframe"
_MAPPED_RESOURCE_SCOPE = "provider:endframe:resource:deployments"
_MAPPED_ACTION_SCOPE = "provider:endframe:action:invoke"


async def _local_handler_ref_impl(*, principal_id: str, resolved_mandate_id: str, payload: str):
    return {
        "mode": "handler_ref",
        "principal_id": principal_id,
        "resolved_mandate_id": resolved_mandate_id,
        "payload": payload,
    }


def _definition_payload() -> dict:
    return {
        "definition_id": _MAPPED_PROVIDER_NAME,
        "resources": {
            "deployments": {
                "actions": {
                    "invoke": {
                        "method": "POST",
                        "path_prefix": "/v1/deployments",
                    }
                }
            }
        },
    }


class _RuntimeQueryStub:
    def __init__(self, rows):
        self._rows = list(rows)

    def filter_by(self, **kwargs):
        rows = [
            row for row in self._rows
            if all(getattr(row, key, None) == value for key, value in kwargs.items())
        ]
        return _RuntimeQueryStub(rows)

    def first(self):
        return self._rows[0] if self._rows else None


class _RuntimeSessionStub:
    def __init__(self, providers):
        self._providers = list(providers)

    def query(self, model):
        if model is GatewayProvider:
            return _RuntimeQueryStub(self._providers)
        if model is RegisteredTool:
            return _RuntimeQueryStub([])
        raise AssertionError(f"Unsupported query model: {model}")


@pytest.mark.unit
class TestMCPContext:
    """Test suite for MCPContext dataclass."""
    
    def test_mcp_context_creation(self):
        """Test MCPContext creation."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={"key": "value"}
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
            metadata={"resolved_mandate_id": "mandate-123"}
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
        self.adapter.get_registered_tool = Mock(
            return_value=SimpleNamespace(
                tool_id=_TOOL_ID,
                active=True,
                provider_name=_MAPPED_PROVIDER_NAME,
                resource_scope=_MAPPED_RESOURCE_SCOPE,
                action_scope=_MAPPED_ACTION_SCOPE,
                provider_definition_id=_MAPPED_PROVIDER_NAME,
            )
        )
        self.adapter._resolve_active_tool_mapping = Mock(
            return_value={
                "tool_id": _TOOL_ID,
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
                "provider_definition_id": _MAPPED_PROVIDER_NAME,
                "execution_mode": "mcp_forward",
                "mcp_server_name": None,
            }
        )
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = Mock(
            spec=ExecutionMandate,
            subject_id="agent-123",
            mandate_id=uuid4(),
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

    def test_as_decorator_requires_non_empty_tool_id(self):
        """Decorator registration must provide an explicit tool_id."""
        with pytest.raises(CaracalError, match="tool_id is required"):
            self.adapter.as_decorator(tool_id="")

    def test_as_decorator_fails_when_tool_not_registered(self):
        """Decorator registration must fail when persisted tool record is missing."""
        self.adapter.get_registered_tool.return_value = None

        with pytest.raises(CaracalError, match="is not registered"):
            self.adapter.as_decorator(tool_id=_TOOL_ID)

    def test_as_decorator_fails_when_tool_inactive(self):
        """Decorator registration must fail when persisted tool record is inactive."""
        self.adapter.get_registered_tool.return_value = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=False,
        )

        with pytest.raises(CaracalError, match="is inactive"):
            self.adapter.as_decorator(tool_id=_TOOL_ID)

    def test_as_decorator_fails_on_import_time_mapping_drift(self):
        """Decorator registration must fail early when mapped provider/action/resource drifted."""
        self.adapter._resolve_active_tool_mapping = Mock(
            side_effect=CaracalError("Mapped provider drift detected")
        )

        with pytest.raises(CaracalError, match="Mapped provider drift detected"):
            self.adapter.as_decorator(tool_id=_TOOL_ID)

    def test_resolve_active_tool_mapping_reports_inactive_due_provider_drift(self):
        """Inactive tools with broken provider mappings should return an explicit drift reason."""
        self.mock_authority_evaluator.db_session = Mock()
        self.adapter.get_registered_tool = Mock(
            side_effect=[
                None,
                SimpleNamespace(
                    tool_id=_TOOL_ID,
                    active=False,
                    provider_name=_MAPPED_PROVIDER_NAME,
                    resource_scope=_MAPPED_RESOURCE_SCOPE,
                    action_scope=_MAPPED_ACTION_SCOPE,
                    provider_definition_id=_MAPPED_PROVIDER_NAME,
                ),
            ]
        )
        self.adapter._validate_tool_mapping = Mock(
            side_effect=CaracalError("Mapped provider 'endframe' was removed")
        )

        with pytest.raises(CaracalError, match="inactive due provider drift"):
            MCPAdapter._resolve_active_tool_mapping(
                self.adapter,
                tool_id=_TOOL_ID,
                mcp_context=None,
                require_credential=False,
            )

    def test_as_decorator_rejects_duplicate_local_binding(self):
        """Only one active local function binding is allowed per tool_id per process."""
        decorator = self.adapter.as_decorator(tool_id=_TOOL_ID)

        async def first(principal_id: str, resolved_mandate_id: str):
            return {"principal_id": principal_id, "resolved_mandate_id": resolved_mandate_id}

        async def second(principal_id: str, resolved_mandate_id: str):
            return {"principal_id": principal_id, "resolved_mandate_id": resolved_mandate_id}

        decorator(first)

        with pytest.raises(CaracalError, match="already bound"):
            decorator(second)
    
    @pytest.mark.asyncio
    async def test_intercept_tool_call_no_applicable_mandate(self):
        """Tool calls should deny when no applicable mandate can be resolved."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={}
        )

        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = None
        
        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context
        )
        
        assert result.success is False
        assert "no applicable mandate" in result.error.lower()
    
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        
        # Mock authority denied
        mock_decision = AuthorityDecision(
            allowed=False,
            reason="Insufficient permissions",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        
        # Mock authority granted
        mock_decision = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
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
        assert result.metadata["execution_mode"] == "mcp_forward"
        assert result.metadata["provider_name"] == _MAPPED_PROVIDER_NAME
        assert result.metadata["resource_scope"] == _MAPPED_RESOURCE_SCOPE
        assert result.metadata["action_scope"] == _MAPPED_ACTION_SCOPE
        self.mock_metering_collector.collect_event.assert_called_once()
        metering_event = self.mock_metering_collector.collect_event.call_args.args[0]
        assert metering_event.metadata["tool_id"] == _TOOL_ID
        assert metering_event.metadata["provider_name"] == _MAPPED_PROVIDER_NAME
        assert metering_event.metadata["resource_scope"] == _MAPPED_RESOURCE_SCOPE
        assert metering_event.metadata["action_scope"] == _MAPPED_ACTION_SCOPE
        assert metering_event.metadata["execution_mode"] == "mcp_forward"

    @pytest.mark.asyncio
    async def test_intercept_tool_call_metering_failure_does_not_fail_execution(self):
        """Post-execution metering failure must not report tool failure."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )
        self.mock_metering_collector.collect_event.side_effect = RuntimeError("metering unavailable")

        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"output": "tool side effect succeeded"}

            result = await self.adapter.intercept_tool_call(
                tool_name="test_tool",
                tool_args={"arg": "value"},
                mcp_context=context,
            )

        assert result.success is True
        assert result.result["output"] == "tool side effect succeeded"
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
        adapter._resolve_active_tool_mapping = Mock(
            return_value={
                "tool_id": _TOOL_ID,
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
                "provider_definition_id": _MAPPED_PROVIDER_NAME,
                "execution_mode": "mcp_forward",
                "mcp_server_name": None,
            }
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
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
        adapter._resolve_active_tool_mapping = Mock(
            return_value={
                "tool_id": _TOOL_ID,
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
                "provider_definition_id": _MAPPED_PROVIDER_NAME,
                "execution_mode": "mcp_forward",
                "mcp_server_name": None,
            }
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
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

    def test_extract_caveat_authority_kwargs_prefers_task_claims_over_top_level_metadata(self):
        adapter = MCPAdapter(
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            caveat_mode="caveat_chain",
            caveat_hmac_key="global-fallback",
        )

        context = MCPContext(
            principal_id="agent-123",
            metadata={
                "task_caveat_chain": [{"index": 0, "type": "action", "value": "spoof"}],
                "task_caveat_hmac_key": "spoofed-hmac",
                "task_id": "spoofed-task",
                "task_token_claims": {
                    "sub": "agent-123",
                    "task_caveat_chain": [{"index": 0, "type": "action", "value": "trusted"}],
                    "task_caveat_hmac_key": "trusted-hmac",
                    "task_id": "trusted-task",
                },
            },
        )

        caveat_kwargs = adapter._extract_caveat_authority_kwargs(context)

        assert caveat_kwargs["caveat_chain"] == [
            {"index": 0, "type": "action", "value": "trusted"}
        ]
        assert caveat_kwargs["caveat_hmac_key"] == "trusted-hmac"
        assert caveat_kwargs["caveat_task_id"] == "trusted-task"
    
    @pytest.mark.asyncio
    async def test_intercept_resource_read_no_applicable_mandate(self):
        """Resource reads should deny when no applicable mandate can be resolved."""
        context = MCPContext(
            principal_id="agent-123",
            metadata={}
        )

        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = None
        
        result = await self.adapter.intercept_resource_read(
            resource_uri="file://test.txt",
            mcp_context=context
        )
        
        assert result.success is False
        assert "no applicable mandate" in result.error.lower()
    
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        
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
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        
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
    async def test_intercept_resource_read_forwards_named_server_from_context_metadata(self):
        """Resource reads should pass mcp_server_name metadata to upstream fetch routing."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={
                "mandate_id": str(mandate_id),
                "mcp_server_name": "server-b",
            },
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="read",
            requested_resource="file://test.txt",
        )

        mock_resource = MCPResource(
            uri="file://test.txt",
            content="test content",
            mime_type="text/plain",
            size=12,
        )
        with patch.object(self.adapter, "_fetch_resource", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = mock_resource

            result = await self.adapter.intercept_resource_read(
                resource_uri="file://test.txt",
                mcp_context=context,
            )

        assert result.success is True
        mock_fetch.assert_called_once_with("file://test.txt", mcp_server_name="server-b")

    @pytest.mark.asyncio
    async def test_fetch_resource_requires_named_server_in_multi_server_mode(self):
        """Multi-server resource reads must be explicit to prevent unintended default routing."""
        adapter = MCPAdapter(
            authority_evaluator=self.mock_authority_evaluator,
            metering_collector=self.mock_metering_collector,
            mcp_server_url="http://server-a:3001",
            mcp_server_urls={
                "server-a": "http://server-a:3001",
                "server-b": "http://server-b:3001",
            },
        )

        with pytest.raises(CaracalError, match="requires mcp_server_name"):
            await adapter._fetch_resource("file://test.txt")

    @pytest.mark.asyncio
    async def test_intercept_resource_read_metering_failure_does_not_fail_read(self):
        """Metering failure after resource fetch must not fail the read response."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action="read",
            requested_resource="file://test.txt",
        )
        self.mock_metering_collector.collect_event.side_effect = RuntimeError("metering unavailable")

        mock_resource = MCPResource(
            uri="file://test.txt",
            content="test content",
            mime_type="text/plain",
            size=12,
        )
        with patch.object(self.adapter, "_fetch_resource", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = mock_resource

            result = await self.adapter.intercept_resource_read(
                resource_uri="file://test.txt",
                mcp_context=context,
            )

        assert result.success is True
        assert result.result.content == "test content"
        self.mock_metering_collector.collect_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_intercept_tool_call_denies_mandate_subject_mismatch(self):
        """Tool call must deny when AuthorityEvaluator rejects caller/subject mismatch."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)}
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "different-agent"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=False,
            reason="Authenticated principal does not match mandate subject",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        result = await self.adapter.intercept_tool_call(
            tool_name="test_tool",
            tool_args={"arg": "value"},
            mcp_context=context,
        )

        assert result.success is False
        assert "does not match mandate subject" in result.error.lower()
        self.mock_authority_evaluator.validate_mandate.assert_called_once()

    @pytest.mark.asyncio
    async def test_as_decorator_uses_explicit_tool_id_for_authorization(self):
        """Decorator wrapper must authorize against the explicit tool_id, not function name."""
        mandate_id = uuid4()

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        @self.adapter.as_decorator(tool_id=_TOOL_ID)
        async def decorated_tool(principal_id: str, mandate_id: str, payload: str):
            del principal_id, mandate_id
            return {"payload": payload}

        result = await decorated_tool(
            principal_id="agent-123",
            mandate_id=str(mandate_id),
            payload="ok",
        )

        assert result == {"payload": "ok"}
        call_kwargs = self.mock_authority_evaluator.validate_mandate.call_args.kwargs
        assert call_kwargs["requested_action"] == _MAPPED_ACTION_SCOPE
        assert call_kwargs["requested_resource"] == _MAPPED_RESOURCE_SCOPE
        self.mock_metering_collector.collect_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_as_decorator_metering_failure_does_not_fail_execution(self):
        """Decorator metering failures should not convert successful execution into failure."""
        mandate_id = uuid4()

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )
        self.mock_metering_collector.collect_event.side_effect = RuntimeError("metering unavailable")

        @self.adapter.as_decorator(tool_id=_TOOL_ID)
        async def decorated_tool(principal_id: str, mandate_id: str):
            del principal_id, mandate_id
            return "executed"

        result = await decorated_tool(
            principal_id="agent-123",
            mandate_id=str(mandate_id),
        )

        assert result == "executed"
        self.mock_metering_collector.collect_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_forward_and_decorator_paths_share_authorization_inputs(self):
        """Forward and local decorator execution should authorize with the same caller/action/resource inputs."""
        mandate_id = uuid4()
        tool_id = _TOOL_ID

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"mode": "forward"}
            forward_result = await self.adapter.intercept_tool_call(
                tool_name=tool_id,
                tool_args={"payload": "ok"},
                mcp_context=context,
            )

        @self.adapter.as_decorator(tool_id=tool_id)
        async def _local_tool(principal_id: str, mandate_id: str, payload: str):
            del principal_id, mandate_id
            return {"mode": "local", "payload": payload}

        local_result = await _local_tool(
            principal_id="agent-123",
            mandate_id=str(mandate_id),
            payload="ok",
        )

        assert forward_result.success is True
        assert forward_result.result == {"mode": "forward"}
        assert local_result == {"mode": "local", "payload": "ok"}

        assert self.mock_authority_evaluator.validate_mandate.call_count == 2
        forward_kwargs = self.mock_authority_evaluator.validate_mandate.call_args_list[0].kwargs
        local_kwargs = self.mock_authority_evaluator.validate_mandate.call_args_list[1].kwargs

        assert forward_kwargs["requested_action"] == local_kwargs["requested_action"] == _MAPPED_ACTION_SCOPE
        assert forward_kwargs["requested_resource"] == local_kwargs["requested_resource"] == _MAPPED_RESOURCE_SCOPE
        assert forward_kwargs["caller_principal_id"] == local_kwargs["caller_principal_id"] == "agent-123"

    @pytest.mark.asyncio
    async def test_intercept_tool_call_attaches_mapped_provider_headers_for_forwarding(self):
        """Forwarded execution should attach provider mapping headers from persisted tool mapping."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"ok": True}

            result = await self.adapter.intercept_tool_call(
                tool_name=_TOOL_ID,
                tool_args={"payload": "ok"},
                mcp_context=context,
            )

        assert result.success is True
        assert mock_forward.call_count == 1
        forward_kwargs = mock_forward.call_args.kwargs
        assert forward_kwargs["mapped_provider_name"] == _MAPPED_PROVIDER_NAME
        assert forward_kwargs["mapped_resource_scope"] == _MAPPED_RESOURCE_SCOPE
        assert forward_kwargs["mapped_action_scope"] == _MAPPED_ACTION_SCOPE

    @pytest.mark.asyncio
    async def test_intercept_tool_call_denies_when_mapped_provider_validation_fails(self):
        """Mapped provider/resource/action drift failures should be denied before execution."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.adapter._resolve_active_tool_mapping.side_effect = CaracalError("Mapped provider 'endframe' for tool is inactive")

        result = await self.adapter.intercept_tool_call(
            tool_name=_TOOL_ID,
            tool_args={"payload": "ok"},
            mcp_context=context,
        )

        assert result.success is False
        assert "authority denied" in result.error.lower()
        assert "mapped provider" in result.error.lower()
        self.mock_authority_evaluator.validate_mandate.assert_not_called()

    @pytest.mark.asyncio
    async def test_intercept_tool_call_routes_to_local_mode_binding(self):
        """Local execution mode should execute the in-process binding and skip upstream forwarding."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )
        self.adapter._resolve_active_tool_mapping.return_value = {
            "tool_id": _TOOL_ID,
            "provider_name": _MAPPED_PROVIDER_NAME,
            "resource_scope": _MAPPED_RESOURCE_SCOPE,
            "action_scope": _MAPPED_ACTION_SCOPE,
            "provider_definition_id": _MAPPED_PROVIDER_NAME,
            "execution_mode": "local",
            "mcp_server_name": None,
        }

        async def _local_impl(*, principal_id: str, resolved_mandate_id: str, payload: str):
            return {
                "mode": "local",
                "principal_id": principal_id,
                "resolved_mandate_id": resolved_mandate_id,
                "payload": payload,
            }

        self.adapter._decorator_bindings[_TOOL_ID] = _local_impl

        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            result = await self.adapter.intercept_tool_call(
                tool_name=_TOOL_ID,
                tool_args={"payload": "ok"},
                mcp_context=context,
            )

        assert result.success is True
        assert result.result["mode"] == "local"
        assert result.result["payload"] == "ok"
        assert mock_forward.call_count == 0

    @pytest.mark.asyncio
    async def test_intercept_tool_call_rejects_misconfigured_forward_target(self):
        """Forward mode must be denied when named upstream target is missing."""
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )
        self.adapter._resolve_active_tool_mapping.return_value = {
            "tool_id": _TOOL_ID,
            "provider_name": _MAPPED_PROVIDER_NAME,
            "resource_scope": _MAPPED_RESOURCE_SCOPE,
            "action_scope": _MAPPED_ACTION_SCOPE,
            "provider_definition_id": _MAPPED_PROVIDER_NAME,
            "execution_mode": "mcp_forward",
            "mcp_server_name": "missing-upstream",
        }

        result = await self.adapter.intercept_tool_call(
            tool_name=_TOOL_ID,
            tool_args={"payload": "ok"},
            mcp_context=context,
        )

        assert result.success is False
        assert "authority denied" in result.error.lower()
        assert "unknown mcp_server_name" in result.error.lower()

    def test_requires_local_credential_for_execution_respects_execution_mode(self):
        self.adapter.get_registered_tool = Mock(
            return_value=SimpleNamespace(
                tool_id=_TOOL_ID,
                active=True,
                execution_mode="local",
                mcp_server_name=None,
            )
        )

        assert self.adapter._requires_local_credential_for_execution(tool_id=_TOOL_ID) is True

        self.adapter.get_registered_tool = Mock(
            return_value=SimpleNamespace(
                tool_id=_TOOL_ID,
                active=True,
                execution_mode="mcp_forward",
                mcp_server_name=None,
            )
        )

        assert self.adapter._requires_local_credential_for_execution(tool_id=_TOOL_ID) is False

    @pytest.mark.asyncio
    async def test_intercept_tool_call_uses_execution_owner_for_credential_requirement(self):
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        self.adapter.get_registered_tool = Mock(
            return_value=SimpleNamespace(
                tool_id=_TOOL_ID,
                active=True,
                execution_mode="mcp_forward",
                mcp_server_name=None,
            )
        )
        self.adapter._resolve_active_tool_mapping = Mock(
            return_value={
                "tool_id": _TOOL_ID,
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
                "provider_definition_id": _MAPPED_PROVIDER_NAME,
                "tool_type": "direct_api",
                "execution_mode": "mcp_forward",
                "mcp_server_name": None,
            }
        )

        with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
            mock_forward.return_value = {"output": "ok"}
            forward_result = await self.adapter.intercept_tool_call(
                tool_name=_TOOL_ID,
                tool_args={"payload": "ok"},
                mcp_context=context,
            )

        assert forward_result.success is True
        assert self.adapter._resolve_active_tool_mapping.call_args.kwargs["require_credential"] is False

        self.adapter.get_registered_tool = Mock(
            return_value=SimpleNamespace(
                tool_id=_TOOL_ID,
                active=True,
                execution_mode="local",
                mcp_server_name=None,
            )
        )
        self.adapter._resolve_active_tool_mapping = Mock(
            return_value={
                "tool_id": _TOOL_ID,
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
                "provider_definition_id": _MAPPED_PROVIDER_NAME,
                "tool_type": "logic",
                "execution_mode": "local",
                "mcp_server_name": None,
            }
        )

        async def _local_impl(*, principal_id: str, resolved_mandate_id: str, payload: str):
            return {
                "principal_id": principal_id,
                "resolved_mandate_id": resolved_mandate_id,
                "payload": payload,
            }

        self.adapter._decorator_bindings[_TOOL_ID] = _local_impl
        local_result = await self.adapter.intercept_tool_call(
            tool_name=_TOOL_ID,
            tool_args={"payload": "ok"},
            mcp_context=context,
        )

        assert local_result.success is True
        assert self.adapter._resolve_active_tool_mapping.call_args.kwargs["require_credential"] is True

        assert self.mock_metering_collector.collect_event.call_count >= 2
        forward_metering_event = self.mock_metering_collector.collect_event.call_args_list[-2].args[0]
        local_metering_event = self.mock_metering_collector.collect_event.call_args_list[-1].args[0]

        expected_keys = {
            "tool_id",
            "tool_name",
            "tool_type",
            "provider_name",
            "resource_scope",
            "action_scope",
            "mcp_server_name",
            "tool_args",
            "execution_mode",
            "mcp_context",
            "resolved_mandate_id",
        }
        assert expected_keys.issubset(set(forward_metering_event.metadata.keys()))
        assert expected_keys.issubset(set(local_metering_event.metadata.keys()))
        assert forward_metering_event.metadata["provider_name"] == local_metering_event.metadata["provider_name"] == _MAPPED_PROVIDER_NAME
        assert forward_metering_event.metadata["resource_scope"] == local_metering_event.metadata["resource_scope"] == _MAPPED_RESOURCE_SCOPE
        assert forward_metering_event.metadata["action_scope"] == local_metering_event.metadata["action_scope"] == _MAPPED_ACTION_SCOPE
        assert forward_metering_event.metadata["execution_mode"] == "mcp_forward"
        assert local_metering_event.metadata["execution_mode"] == "local"

    @pytest.mark.asyncio
    async def test_forward_to_mcp_server_preserves_mapped_selectors_in_metadata(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "output": "ok",
            "metadata": {
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
                "action_scope": _MAPPED_ACTION_SCOPE,
            },
        }
        response.text = '{"output":"ok"}'

        client = AsyncMock()
        client.post = AsyncMock(return_value=response)

        with patch.object(self.adapter, "_get_http_client", new_callable=AsyncMock) as mock_get_client:
            mock_get_client.return_value = client
            result = await self.adapter._forward_to_mcp_server(
                tool_name=_TOOL_ID,
                tool_args={"payload": "ok"},
                server_url="http://localhost:3001",
                mapped_provider_name=_MAPPED_PROVIDER_NAME,
                mapped_resource_scope=_MAPPED_RESOURCE_SCOPE,
                mapped_action_scope=_MAPPED_ACTION_SCOPE,
            )

        assert result["metadata"]["provider_name"] == _MAPPED_PROVIDER_NAME
        assert result["metadata"]["resource_scope"] == _MAPPED_RESOURCE_SCOPE
        assert result["metadata"]["action_scope"] == _MAPPED_ACTION_SCOPE

    @pytest.mark.asyncio
    async def test_forward_to_mcp_server_rejects_missing_selector_echo_from_upstream(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "output": "ok",
            "metadata": {
                "provider_name": _MAPPED_PROVIDER_NAME,
                "resource_scope": _MAPPED_RESOURCE_SCOPE,
            },
        }
        response.text = '{"output":"ok"}'

        client = AsyncMock()
        client.post = AsyncMock(return_value=response)

        with patch.object(self.adapter, "_get_http_client", new_callable=AsyncMock) as mock_get_client:
            mock_get_client.return_value = client
            with pytest.raises(CaracalError, match="missing required 'action_scope' selector"):
                await self.adapter._forward_to_mcp_server(
                    tool_name=_TOOL_ID,
                    tool_args={"payload": "ok"},
                    server_url="http://localhost:3001",
                    mapped_provider_name=_MAPPED_PROVIDER_NAME,
                    mapped_resource_scope=_MAPPED_RESOURCE_SCOPE,
                    mapped_action_scope=_MAPPED_ACTION_SCOPE,
                )

    @pytest.mark.asyncio
    async def test_execute_local_tool_resolves_callable_from_handler_ref_without_decorator_binding(self):
        result = await self.adapter._execute_local_tool(
            tool_id=_TOOL_ID,
            principal_id="agent-123",
            resolved_mandate_id=str(uuid4()),
            tool_args={"payload": "ok"},
            handler_ref=f"{__name__}:_local_handler_ref_impl",
            workspace_name="default",
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            tool_type="logic",
            allowed_downstream_scopes=[],
        )

        assert result["mode"] == "handler_ref"
        assert result["payload"] == "ok"
        assert result["principal_id"] == "agent-123"

    @pytest.mark.asyncio
    async def test_intercept_tool_call_denies_logic_downstream_scope_outside_allowed_contract(self):
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate

        self.adapter._resolve_active_tool_mapping.return_value = {
            "tool_id": "downstream.tool",
            "provider_name": _MAPPED_PROVIDER_NAME,
            "resource_scope": _MAPPED_RESOURCE_SCOPE,
            "action_scope": _MAPPED_ACTION_SCOPE,
            "provider_definition_id": _MAPPED_PROVIDER_NAME,
            "tool_type": "direct_api",
            "execution_mode": "mcp_forward",
            "mcp_server_name": None,
        }

        token = self.adapter._active_logic_execution.set(
            {
                "tool_id": "parent.logic.tool",
                "allowed_downstream_scopes": ["provider:endframe:action:status"],
            }
        )
        try:
            result = await self.adapter.intercept_tool_call(
                tool_name="downstream.tool",
                tool_args={"payload": "ok"},
                mcp_context=context,
            )
        finally:
            self.adapter._active_logic_execution.reset(token)

        assert result.success is False
        assert "downstream scope denied" in result.error.lower()
        self.mock_authority_evaluator.validate_mandate.assert_not_called()

    @pytest.mark.asyncio
    async def test_intercept_tool_call_allows_logic_downstream_scope_in_allowed_contract(self):
        mandate_id = uuid4()
        context = MCPContext(
            principal_id="agent-123",
            metadata={"mandate_id": str(mandate_id)},
        )

        mock_mandate = Mock(spec=ExecutionMandate)
        mock_mandate.subject_id = "agent-123"
        self.mock_authority_evaluator.resolve_mandate_for_principal.return_value = mock_mandate
        self.mock_authority_evaluator.validate_mandate.return_value = AuthorityDecision(
            allowed=True,
            reason="Authority granted",
            mandate_id=mandate_id,
            requested_action=_MAPPED_ACTION_SCOPE,
            requested_resource=_MAPPED_RESOURCE_SCOPE,
        )

        self.adapter._resolve_active_tool_mapping.return_value = {
            "tool_id": "downstream.tool",
            "provider_name": _MAPPED_PROVIDER_NAME,
            "resource_scope": _MAPPED_RESOURCE_SCOPE,
            "action_scope": _MAPPED_ACTION_SCOPE,
            "provider_definition_id": _MAPPED_PROVIDER_NAME,
            "tool_type": "direct_api",
            "execution_mode": "mcp_forward",
            "mcp_server_name": None,
        }

        token = self.adapter._active_logic_execution.set(
            {
                "tool_id": "parent.logic.tool",
                "allowed_downstream_scopes": [_MAPPED_ACTION_SCOPE],
            }
        )
        try:
            with patch.object(self.adapter, "_forward_to_mcp_server", new_callable=AsyncMock) as mock_forward:
                mock_forward.return_value = {"ok": True}
                result = await self.adapter.intercept_tool_call(
                    tool_name="downstream.tool",
                    tool_args={"payload": "ok"},
                    mcp_context=context,
                )
        finally:
            self.adapter._active_logic_execution.reset(token)

        assert result.success is True
        assert result.result == {"ok": True}

    @pytest.mark.asyncio
    async def test_forward_to_mcp_server_rejects_selector_mismatch_from_upstream(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "output": "ok",
            "metadata": {
                "provider_name": "other-provider",
            },
        }
        response.text = '{"output":"ok"}'

        client = AsyncMock()
        client.post = AsyncMock(return_value=response)

        with patch.object(self.adapter, "_get_http_client", new_callable=AsyncMock) as mock_get_client:
            mock_get_client.return_value = client
            with pytest.raises(CaracalError, match="mismatch for provider_name"):
                await self.adapter._forward_to_mcp_server(
                    tool_name=_TOOL_ID,
                    tool_args={"payload": "ok"},
                    server_url="http://localhost:3001",
                    mapped_provider_name=_MAPPED_PROVIDER_NAME,
                    mapped_resource_scope=_MAPPED_RESOURCE_SCOPE,
                    mapped_action_scope=_MAPPED_ACTION_SCOPE,
                )

    def test_resolve_active_tool_mapping_rejects_removed_provider(self):
        """Mapped tool calls must be rejected when provider mapping has been removed."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with pytest.raises(MCPProviderMissingError, match="was removed"):
            mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(principal_id="agent-123", metadata={"workspace": "default"}),
                require_credential=False,
            )

    def test_resolve_active_tool_mapping_rejects_inactive_provider(self):
        """Mapped tool calls must be rejected when provider is inactive."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
        )
        provider_row = GatewayProvider(
            provider_id=_MAPPED_PROVIDER_NAME,
            name="Endframe",
            base_url="https://api.endframe.dev",
            auth_scheme="none",
            definition=_definition_payload(),
            enabled=False,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([provider_row])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with pytest.raises(MCPProviderMissingError, match="is inactive"):
            mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(principal_id="agent-123", metadata={"workspace": "default"}),
                require_credential=False,
            )

    def test_resolve_active_tool_mapping_rejects_provider_scope_drift(self):
        """Mapped tool calls must be rejected when provider definition removes mapped scopes."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
        )
        provider_row = GatewayProvider(
            provider_id=_MAPPED_PROVIDER_NAME,
            name="Endframe",
            base_url="https://api.endframe.dev",
            auth_scheme="none",
            definition={
                "definition_id": _MAPPED_PROVIDER_NAME,
                "resources": {
                    "deployments": {
                        "actions": {
                            "status": {
                                "method": "GET",
                                "path_prefix": "/v1/deployments/status",
                            }
                        }
                    }
                },
            },
            enabled=True,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([provider_row])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with pytest.raises(MCPToolMappingMismatchError, match="Action scope 'provider:endframe:action:invoke'"):
            mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(principal_id="agent-123", metadata={"workspace": "default"}),
                require_credential=False,
            )

    def test_resolve_active_tool_mapping_raises_unknown_tool_error_class(self):
        """Unknown tool IDs should raise MCPUnknownToolError deterministically."""
        self.adapter.get_registered_tool = Mock(return_value=None)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with pytest.raises(MCPUnknownToolError, match="Unknown tool_id"):
            mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(principal_id="agent-123", metadata={"workspace": "default"}),
                require_credential=False,
            )

    def test_resolve_active_tool_mapping_rejects_unresolvable_credential_ref(self):
        """Mapped provider credentials must resolve before execution proceeds."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
        )
        provider_row = GatewayProvider(
            provider_id=_MAPPED_PROVIDER_NAME,
            name="Endframe",
            base_url="https://api.endframe.dev",
            auth_scheme="api_key",
            credential_ref="caracal:default/providers/endframe/credential",
            definition=_definition_payload(),
            enabled=True,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([provider_row])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with patch(
            "caracal.mcp.adapter.resolve_workspace_provider_credential",
            side_effect=SecretNotFoundError("Secret not found"),
        ):
            with pytest.raises(CaracalError, match="Credential not found for mapped provider"):
                mapping_fn(
                    tool_id=_TOOL_ID,
                    mcp_context=MCPContext(principal_id="agent-123", metadata={"workspace": "default"}),
                    require_credential=True,
                )

    def test_resolve_active_tool_mapping_prefers_persisted_workspace_for_credentials(self):
        """Credential resolution should prefer persisted tool workspace over request metadata."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
            workspace_name="persisted-workspace",
        )
        provider_row = GatewayProvider(
            provider_id=_MAPPED_PROVIDER_NAME,
            name="Endframe",
            base_url="https://api.endframe.dev",
            auth_scheme="api_key",
            credential_ref="caracal:default/providers/endframe/credential",
            definition=_definition_payload(),
            enabled=True,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([provider_row])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with patch(
            "caracal.mcp.adapter.resolve_workspace_provider_credential",
        ) as mock_resolve_credential:
            mapping = mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(
                    principal_id="agent-123",
                    metadata={"workspace": "request-workspace"},
                ),
                require_credential=True,
            )

        mock_resolve_credential.assert_called_once_with(
            "persisted-workspace",
            "caracal:default/providers/endframe/credential",
        )
        assert mapping["workspace_name"] == "persisted-workspace"

    def test_resolve_active_tool_mapping_falls_back_to_context_workspace_when_mapping_missing(self):
        """Credential resolution should use request workspace only when mapping workspace is missing."""
        tool_row = SimpleNamespace(
            tool_id=_TOOL_ID,
            active=True,
            provider_name=_MAPPED_PROVIDER_NAME,
            resource_scope=_MAPPED_RESOURCE_SCOPE,
            action_scope=_MAPPED_ACTION_SCOPE,
            provider_definition_id=_MAPPED_PROVIDER_NAME,
            workspace_name=None,
        )
        provider_row = GatewayProvider(
            provider_id=_MAPPED_PROVIDER_NAME,
            name="Endframe",
            base_url="https://api.endframe.dev",
            auth_scheme="api_key",
            credential_ref="caracal:default/providers/endframe/credential",
            definition=_definition_payload(),
            enabled=True,
        )

        self.adapter.get_registered_tool = Mock(return_value=tool_row)
        self.mock_authority_evaluator.db_session = _RuntimeSessionStub([provider_row])

        mapping_fn = MCPAdapter._resolve_active_tool_mapping.__get__(self.adapter, MCPAdapter)
        with patch(
            "caracal.mcp.adapter.resolve_workspace_provider_credential",
        ) as mock_resolve_credential:
            mapping = mapping_fn(
                tool_id=_TOOL_ID,
                mcp_context=MCPContext(
                    principal_id="agent-123",
                    metadata={"workspace_name": "request-workspace"},
                ),
                require_credential=True,
            )

        mock_resolve_credential.assert_called_once_with(
            "request-workspace",
            "caracal:default/providers/endframe/credential",
        )
        assert mapping["workspace_name"] == "request-workspace"
    
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
