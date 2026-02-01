#!/usr/bin/env python3
"""
Simple test script to verify MCP adapter decorator functionality.
"""

import asyncio
import sys
from decimal import Decimal
from uuid import uuid4
from unittest.mock import Mock

# Add parent directory to path
sys.path.insert(0, '.')

from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.core.policy import PolicyEvaluator, PolicyDecision
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook


def create_test_adapter():
    """Create a test MCP adapter with mocked dependencies."""
    # Mock pricebook
    mock_pricebook = Mock(spec=Pricebook)
    mock_pricebook.get_price = Mock(return_value=Decimal("0.01"))
    
    # Mock policy evaluator
    mock_policy_evaluator = Mock(spec=PolicyEvaluator)
    mock_policy_evaluator.check_budget = Mock(return_value=PolicyDecision(
        allowed=True,
        reason="Within budget",
        remaining_budget=Decimal("100.00"),
        provisional_charge_id=str(uuid4())
    ))
    
    # Mock metering collector
    mock_metering_collector = Mock(spec=MeteringCollector)
    mock_metering_collector.collect_event = Mock()
    
    # Create cost calculator
    cost_calculator = MCPCostCalculator(mock_pricebook)
    
    # Create adapter
    adapter = MCPAdapter(
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector,
        cost_calculator=cost_calculator
    )
    
    return adapter, mock_policy_evaluator, mock_metering_collector


async def test_decorator_basic():
    """Test basic decorator functionality."""
    print("Test 1: Basic decorator functionality")
    
    adapter, policy_eval, metering = create_test_adapter()
    
    @adapter.as_decorator()
    async def my_tool(agent_id: str, param1: str, param2: int):
        """Test tool."""
        return {"result": f"{param1}_{param2}"}
    
    agent_id = str(uuid4())
    result = await my_tool(agent_id=agent_id, param1="test", param2=42)
    
    assert result == {"result": "test_42"}, f"Expected result mismatch: {result}"
    assert policy_eval.check_budget.called, "Budget check not called"
    assert metering.collect_event.called, "Metering event not collected"
    
    print("✓ Test 1 passed")


async def test_decorator_positional_agent_id():
    """Test decorator with positional agent_id."""
    print("Test 2: Decorator with positional agent_id")
    
    adapter, policy_eval, metering = create_test_adapter()
    
    @adapter.as_decorator()
    async def my_tool(agent_id: str, param1: str):
        """Test tool."""
        return {"result": param1}
    
    agent_id = str(uuid4())
    result = await my_tool(agent_id, param1="test")
    
    assert result == {"result": "test"}, f"Expected result mismatch: {result}"
    assert policy_eval.check_budget.called, "Budget check not called"
    
    print("✓ Test 2 passed")


async def test_decorator_budget_exceeded():
    """Test decorator when budget is exceeded."""
    print("Test 3: Decorator with budget exceeded")
    
    adapter, policy_eval, metering = create_test_adapter()
    
    # Configure to deny budget
    policy_eval.check_budget = Mock(return_value=PolicyDecision(
        allowed=False,
        reason="Budget exceeded",
        remaining_budget=Decimal("0")
    ))
    
    @adapter.as_decorator()
    async def my_tool(agent_id: str, param1: str):
        """Test tool."""
        return {"result": param1}
    
    agent_id = str(uuid4())
    
    try:
        await my_tool(agent_id=agent_id, param1="test")
        assert False, "Expected BudgetExceededError"
    except Exception as e:
        assert "Budget" in str(e), f"Expected budget error, got: {e}"
    
    print("✓ Test 3 passed")


async def test_decorator_missing_agent_id():
    """Test decorator when agent_id is missing."""
    print("Test 4: Decorator with missing agent_id")
    
    adapter, policy_eval, metering = create_test_adapter()
    
    @adapter.as_decorator()
    async def my_tool(param1: str):
        """Test tool without agent_id."""
        return {"result": param1}
    
    try:
        await my_tool(param1="test")
        assert False, "Expected CaracalError"
    except Exception as e:
        assert "agent_id" in str(e).lower(), f"Expected agent_id error, got: {e}"
    
    print("✓ Test 4 passed")


async def test_decorator_sync_function():
    """Test decorator with synchronous function."""
    print("Test 5: Decorator with synchronous function")
    
    adapter, policy_eval, metering = create_test_adapter()
    
    @adapter.as_decorator()
    def my_tool(agent_id: str, param1: str):
        """Test synchronous tool."""
        return {"result": param1}
    
    agent_id = str(uuid4())
    result = await my_tool(agent_id=agent_id, param1="test")
    
    assert result == {"result": "test"}, f"Expected result mismatch: {result}"
    
    print("✓ Test 5 passed")


async def main():
    """Run all tests."""
    print("=" * 60)
    print("Testing MCP Adapter Decorator")
    print("=" * 60)
    print()
    
    try:
        await test_decorator_basic()
        await test_decorator_positional_agent_id()
        await test_decorator_budget_exceeded()
        await test_decorator_missing_agent_id()
        await test_decorator_sync_function()
        
        print()
        print("=" * 60)
        print("All tests passed! ✓")
        print("=" * 60)
        return 0
    except Exception as e:
        print()
        print("=" * 60)
        print(f"Test failed: {e}")
        print("=" * 60)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
