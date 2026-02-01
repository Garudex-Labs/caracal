"""
Unit tests for MCP Adapter.

Tests the MCPAdapter service for intercepting tool calls and resource reads.
"""

import pytest
from decimal import Decimal
from datetime import datetime
from unittest.mock import Mock, AsyncMock, patch
from uuid import uuid4

from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.core.policy import PolicyEvaluator, PolicyDecision
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook
from caracal.exceptions import BudgetExceededError


@pytest.fixture
def mock_pricebook():
    """Create a mock pricebook."""
    pricebook = Mock(spec=Pricebook)
    pricebook.get_price = Mock(return_value=Decimal("0.01"))
    return pricebook


@pytest.fixture
def mock_policy_evaluator():
    """Create a mock policy evaluator."""
    evaluator = Mock(spec=PolicyEvaluator)
    evaluator.check_budget = Mock(return_value=PolicyDecision(
        allowed=True,
        reason="Within budget",
        remaining_budget=Decimal("100.00"),
        provisional_charge_id=str(uuid4())
    ))
    return evaluator


@pytest.fixture
def mock_metering_collector():
    """Create a mock metering collector."""
    collector = Mock(spec=MeteringCollector)
    collector.collect_event = Mock()
    return collector


@pytest.fixture
def cost_calculator(mock_pricebook):
    """Create a cost calculator."""
    return MCPCostCalculator(mock_pricebook)


@pytest.fixture
def mcp_adapter(mock_policy_evaluator, mock_metering_collector, cost_calculator):
    """Create an MCP adapter."""
    return MCPAdapter(
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector,
        cost_calculator=cost_calculator
    )


@pytest.fixture
def mcp_context():
    """Create an MCP context."""
    return MCPContext(
        agent_id=str(uuid4()),
        metadata={"source": "test"}
    )


class TestMCPAdapter:
    """Test suite for MCPAdapter."""

    @pytest.mark.asyncio
    async def test_intercept_tool_call_success(self, mcp_adapter, mcp_context):
        """Test successful tool call interception."""
        tool_name = "test_tool"
        tool_args = {"arg1": "value1"}
        
        result = await mcp_adapter.intercept_tool_call(tool_name, tool_args, mcp_context)
        
        assert result.success is True
        assert result.result is not None
        assert result.error is None
        assert "estimated_cost" in result.metadata
        assert "actual_cost" in result.metadata

    @pytest.mark.asyncio
    async def test_intercept_tool_call_budget_exceeded(
        self, mcp_adapter, mcp_context, mock_policy_evaluator
    ):
        """Test tool call interception when budget is exceeded."""
        # Configure policy evaluator to deny
        mock_policy_evaluator.check_budget = Mock(return_value=PolicyDecision(
            allowed=False,
            reason="Budget exceeded",
            remaining_budget=Decimal("0")
        ))
        
        tool_name = "test_tool"
        tool_args = {"arg1": "value1"}
        
        with pytest.raises(BudgetExceededError):
            await mcp_adapter.intercept_tool_call(tool_name, tool_args, mcp_context)

    @pytest.mark.asyncio
    async def test_intercept_tool_call_emits_metering_event(
        self, mcp_adapter, mcp_context, mock_metering_collector
    ):
        """Test that tool call interception emits a metering event."""
        tool_name = "test_tool"
        tool_args = {"arg1": "value1"}
        
        await mcp_adapter.intercept_tool_call(tool_name, tool_args, mcp_context)
        
        # Verify metering event was collected
        assert mock_metering_collector.collect_event.called
        call_args = mock_metering_collector.collect_event.call_args
        event = call_args[0][0]
        
        assert event.agent_id == mcp_context.agent_id
        assert event.resource_type == f"mcp.tool.{tool_name}"
        assert event.quantity == Decimal("1")

    @pytest.mark.asyncio
    async def test_intercept_resource_read_success(self, mcp_adapter, mcp_context):
        """Test successful resource read interception."""
        resource_uri = "file:///test/resource.txt"
        
        result = await mcp_adapter.intercept_resource_read(resource_uri, mcp_context)
        
        assert result.success is True
        assert result.result is not None
        assert result.error is None
        assert "estimated_cost" in result.metadata
        assert "actual_cost" in result.metadata
        assert "resource_size" in result.metadata

    @pytest.mark.asyncio
    async def test_intercept_resource_read_budget_exceeded(
        self, mcp_adapter, mcp_context, mock_policy_evaluator
    ):
        """Test resource read interception when budget is exceeded."""
        # Configure policy evaluator to deny
        mock_policy_evaluator.check_budget = Mock(return_value=PolicyDecision(
            allowed=False,
            reason="Budget exceeded",
            remaining_budget=Decimal("0")
        ))
        
        resource_uri = "file:///test/resource.txt"
        
        with pytest.raises(BudgetExceededError):
            await mcp_adapter.intercept_resource_read(resource_uri, mcp_context)

    @pytest.mark.asyncio
    async def test_intercept_resource_read_emits_metering_event(
        self, mcp_adapter, mcp_context, mock_metering_collector
    ):
        """Test that resource read interception emits a metering event."""
        resource_uri = "file:///test/resource.txt"
        
        await mcp_adapter.intercept_resource_read(resource_uri, mcp_context)
        
        # Verify metering event was collected
        assert mock_metering_collector.collect_event.called
        call_args = mock_metering_collector.collect_event.call_args
        event = call_args[0][0]
        
        assert event.agent_id == mcp_context.agent_id
        assert "mcp.resource." in event.resource_type

    def test_extract_agent_id_from_context(self, mcp_adapter, mcp_context):
        """Test extracting agent ID from MCP context."""
        agent_id = mcp_adapter._extract_agent_id(mcp_context)
        assert agent_id == mcp_context.agent_id

    def test_extract_agent_id_missing(self, mcp_adapter):
        """Test extracting agent ID when missing from context."""
        from caracal.exceptions import CaracalError
        
        context = MCPContext(agent_id="", metadata={})
        
        with pytest.raises(CaracalError, match="Agent ID not found"):
            mcp_adapter._extract_agent_id(context)

    def test_get_resource_type_file(self, mcp_adapter):
        """Test resource type extraction for file URIs."""
        resource_type = mcp_adapter._get_resource_type("file:///test/file.txt")
        assert resource_type == "file"

    def test_get_resource_type_http(self, mcp_adapter):
        """Test resource type extraction for HTTP URIs."""
        resource_type = mcp_adapter._get_resource_type("https://example.com/resource")
        assert resource_type == "http"

    def test_get_resource_type_database(self, mcp_adapter):
        """Test resource type extraction for database URIs."""
        resource_type = mcp_adapter._get_resource_type("db://localhost/table")
        assert resource_type == "database"

    def test_get_resource_type_s3(self, mcp_adapter):
        """Test resource type extraction for S3 URIs."""
        resource_type = mcp_adapter._get_resource_type("s3://bucket/key")
        assert resource_type == "s3"

    def test_get_resource_type_unknown(self, mcp_adapter):
        """Test resource type extraction for unknown URIs."""
        resource_type = mcp_adapter._get_resource_type("unknown://resource")
        assert resource_type == "unknown"


class TestMCPCostCalculator:
    """Test suite for MCPCostCalculator."""

    @pytest.mark.asyncio
    async def test_estimate_tool_cost_default(self, cost_calculator):
        """Test default tool cost estimation."""
        cost = await cost_calculator.estimate_tool_cost("test_tool", {})
        assert cost > Decimal("0")

    @pytest.mark.asyncio
    async def test_estimate_tool_cost_llm(self, cost_calculator, mock_pricebook):
        """Test LLM tool cost estimation."""
        # Configure pricebook for LLM pricing
        def get_price_side_effect(resource_type):
            if "input_tokens" in resource_type:
                return Decimal("0.00003")
            elif "output_tokens" in resource_type:
                return Decimal("0.00006")
            return Decimal("0.01")
        
        mock_pricebook.get_price = Mock(side_effect=get_price_side_effect)
        
        tool_args = {
            "prompt": "Test prompt",
            "max_tokens": 1000,
            "model": "gpt-4"
        }
        
        cost = await cost_calculator.estimate_tool_cost("llm_tool", tool_args)
        assert cost > Decimal("0")

    @pytest.mark.asyncio
    async def test_estimate_resource_cost_with_size(self, cost_calculator):
        """Test resource cost estimation with known size."""
        cost = await cost_calculator.estimate_resource_cost(
            "file:///test.txt",
            estimated_size=1048576  # 1 MB
        )
        assert cost > Decimal("0")

    @pytest.mark.asyncio
    async def test_estimate_resource_cost_without_size(self, cost_calculator):
        """Test resource cost estimation without known size."""
        cost = await cost_calculator.estimate_resource_cost(
            "file:///test.txt",
            estimated_size=0
        )
        assert cost > Decimal("0")

    def test_is_llm_tool_by_name(self, cost_calculator):
        """Test LLM tool detection by name."""
        assert cost_calculator._is_llm_tool("gpt4_completion", {}) is True
        assert cost_calculator._is_llm_tool("claude_chat", {}) is True
        assert cost_calculator._is_llm_tool("llm_generate", {}) is True

    def test_is_llm_tool_by_args(self, cost_calculator):
        """Test LLM tool detection by arguments."""
        assert cost_calculator._is_llm_tool("tool", {"prompt": "test"}) is True
        assert cost_calculator._is_llm_tool("tool", {"model": "gpt-4"}) is True
        assert cost_calculator._is_llm_tool("tool", {"max_tokens": 1000}) is True

    def test_is_api_tool_by_name(self, cost_calculator):
        """Test API tool detection by name."""
        assert cost_calculator._is_api_tool("api_call", {}) is True
        assert cost_calculator._is_api_tool("http_request", {}) is True
        assert cost_calculator._is_api_tool("rest_api", {}) is True

    def test_is_api_tool_by_args(self, cost_calculator):
        """Test API tool detection by arguments."""
        assert cost_calculator._is_api_tool("tool", {"endpoint": "/api/v1"}) is True
        assert cost_calculator._is_api_tool("tool", {"url": "https://api.com"}) is True
        assert cost_calculator._is_api_tool("tool", {"method": "POST"}) is True


class TestMCPAdapterDecorator:
    """Test suite for MCPAdapter decorator functionality."""

    @pytest.mark.asyncio
    async def test_decorator_with_async_function(self, mcp_adapter):
        """Test decorator with async function."""
        @mcp_adapter.as_decorator()
        async def test_tool(agent_id: str, param1: str, param2: int):
            """Test MCP tool."""
            return {"result": f"{param1}_{param2}"}
        
        agent_id = str(uuid4())
        result = await test_tool(agent_id=agent_id, param1="test", param2=42)
        
        assert result == {"result": "test_42"}

    @pytest.mark.asyncio
    async def test_decorator_with_positional_agent_id(self, mcp_adapter):
        """Test decorator with agent_id as first positional argument."""
        @mcp_adapter.as_decorator()
        async def test_tool(agent_id: str, param1: str):
            """Test MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        result = await test_tool(agent_id, param1="test")
        
        assert result == {"result": "test"}

    @pytest.mark.asyncio
    async def test_decorator_budget_check(
        self, mcp_adapter, mock_policy_evaluator, mock_metering_collector
    ):
        """Test that decorator performs budget check."""
        @mcp_adapter.as_decorator()
        async def test_tool(agent_id: str, param1: str):
            """Test MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        await test_tool(agent_id=agent_id, param1="test")
        
        # Verify budget check was called
        assert mock_policy_evaluator.check_budget.called

    @pytest.mark.asyncio
    async def test_decorator_emits_metering_event(
        self, mcp_adapter, mock_metering_collector
    ):
        """Test that decorator emits metering event."""
        @mcp_adapter.as_decorator()
        async def test_tool(agent_id: str, param1: str):
            """Test MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        await test_tool(agent_id=agent_id, param1="test")
        
        # Verify metering event was collected
        assert mock_metering_collector.collect_event.called
        call_args = mock_metering_collector.collect_event.call_args
        event = call_args[0][0]
        
        assert event.agent_id == agent_id
        assert event.resource_type == "mcp.tool.test_tool"
        assert event.quantity == Decimal("1")

    @pytest.mark.asyncio
    async def test_decorator_budget_exceeded(
        self, mcp_adapter, mock_policy_evaluator
    ):
        """Test decorator when budget is exceeded."""
        # Configure policy evaluator to deny
        mock_policy_evaluator.check_budget = Mock(return_value=PolicyDecision(
            allowed=False,
            reason="Budget exceeded",
            remaining_budget=Decimal("0")
        ))
        
        @mcp_adapter.as_decorator()
        async def test_tool(agent_id: str, param1: str):
            """Test MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        
        with pytest.raises(BudgetExceededError):
            await test_tool(agent_id=agent_id, param1="test")

    @pytest.mark.asyncio
    async def test_decorator_missing_agent_id(self, mcp_adapter):
        """Test decorator when agent_id is missing."""
        from caracal.exceptions import CaracalError
        
        @mcp_adapter.as_decorator()
        async def test_tool(param1: str):
            """Test MCP tool without agent_id."""
            return {"result": param1}
        
        with pytest.raises(CaracalError, match="agent_id is required"):
            await test_tool(param1="test")

    @pytest.mark.asyncio
    async def test_decorator_with_sync_function(self, mcp_adapter):
        """Test decorator with synchronous function."""
        @mcp_adapter.as_decorator()
        def test_tool(agent_id: str, param1: str):
            """Test synchronous MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        result = await test_tool(agent_id=agent_id, param1="test")
        
        assert result == {"result": "test"}

    @pytest.mark.asyncio
    async def test_decorator_preserves_function_metadata(self, mcp_adapter):
        """Test that decorator preserves function name and docstring."""
        @mcp_adapter.as_decorator()
        async def my_custom_tool(agent_id: str, param1: str):
            """Custom tool docstring."""
            return {"result": param1}
        
        assert my_custom_tool.__name__ == "my_custom_tool"
        assert "Custom tool docstring" in my_custom_tool.__doc__

    @pytest.mark.asyncio
    async def test_decorator_with_alternative_agent_id_names(self, mcp_adapter):
        """Test decorator with alternative agent_id parameter names."""
        @mcp_adapter.as_decorator()
        async def test_tool(param1: str):
            """Test MCP tool."""
            return {"result": param1}
        
        agent_id = str(uuid4())
        
        # Test with 'agent' parameter name
        result = await test_tool(agent=agent_id, param1="test")
        assert result == {"result": "test"}
        
        # Test with 'caracal_agent_id' parameter name
        result = await test_tool(caracal_agent_id=agent_id, param1="test")
        assert result == {"result": "test"}

    @pytest.mark.asyncio
    async def test_decorator_error_handling(self, mcp_adapter):
        """Test decorator error handling when tool execution fails."""
        from caracal.exceptions import CaracalError
        
        @mcp_adapter.as_decorator()
        async def failing_tool(agent_id: str):
            """Tool that raises an error."""
            raise ValueError("Tool execution failed")
        
        agent_id = str(uuid4())
        
        with pytest.raises(CaracalError, match="MCP tool execution failed"):
            await failing_tool(agent_id=agent_id)
