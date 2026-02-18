#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

"""
Demo of MCP Adapter decorator for SDK plugin mode.

This example demonstrates how to use the MCP adapter decorator to automatically
enforce budget checks and emit metering events for MCP tool functions.
"""

import asyncio
from decimal import Decimal
from uuid import uuid4

from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.core.policy import PolicyEvaluator, PolicyStore, PolicyDecision
from caracal.core.metering import MeteringCollector, LedgerWriter
from caracal.core.pricebook import Pricebook
from caracal.core.identity import AgentRegistry


def setup_caracal_components():
    """
    Set up Caracal components for the demo.
    
    In a real application, these would be properly initialized with
    database connections and configuration.
    """
    # For demo purposes, we'll use in-memory implementations
    pricebook = Pricebook()
    
    # Add some prices for MCP tools
    pricebook.set_price("mcp.tool.default", Decimal("0.01"))
    pricebook.set_price("mcp.tool.llm_completion", Decimal("0.10"))
    pricebook.set_price("mcp.tool.database_query", Decimal("0.05"))
    
    # Create policy evaluator (simplified for demo)
    class SimplePolicyEvaluator:
        def check_budget(self, agent_id: str, estimated_cost: Decimal) -> PolicyDecision:
            # For demo, always allow with a large budget
            return PolicyDecision(
                allowed=True,
                reason="Within budget",
                remaining_budget=Decimal("1000.00"),
                provisional_charge_id=str(uuid4())
            )
    
    policy_evaluator = SimplePolicyEvaluator()
    
    # Create metering collector (simplified for demo)
    class SimpleMetering:
        def __init__(self):
            self.events = []
        
        def collect_event(self, event, provisional_charge_id=None):
            self.events.append({
                "event": event,
                "provisional_charge_id": provisional_charge_id
            })
            print(f"  📜 Metered: {event.resource_type} - ${event.metadata.get('actual_cost', '0.00')}")
    
    metering_collector = SimpleMetering()
    
    # Create cost calculator
    cost_calculator = MCPCostCalculator(pricebook)
    
    # Create MCP adapter
    mcp_adapter = MCPAdapter(
        policy_evaluator=policy_evaluator,
        metering_collector=metering_collector,
        cost_calculator=cost_calculator
    )
    
    return mcp_adapter, metering_collector


async def demo_basic_decorator():
    """Demo 1: Basic decorator usage."""
    print("\n" + "="*60)
    print("Demo 1: Basic Decorator Usage")
    print("="*60)
    
    mcp_adapter, metering = setup_caracal_components()
    
    # Define an MCP tool with the decorator
    @mcp_adapter.as_decorator()
    async def search_documents(agent_id: str, query: str, max_results: int = 10):
        """Search documents based on a query."""
        print(f"  🔍 Searching for: '{query}' (max {max_results} results)")
        # Simulate search operation
        await asyncio.sleep(0.1)
        return {
            "results": [
                {"id": 1, "title": "Document 1", "relevance": 0.95},
                {"id": 2, "title": "Document 2", "relevance": 0.87},
            ],
            "total": 2
        }
    
    # Use the decorated tool
    agent_id = str(uuid4())
    print(f"\n👾 Agent: {agent_id[:8]}...")
    print("  ✅ Budget check passed")
    
    result = await search_documents(
        agent_id=agent_id,
        query="machine learning",
        max_results=5
    )
    
    print(f"  📄 Results: {result['total']} documents found")
    print(f"  🪙 Total events metered: {len(metering.events)}")


async def demo_llm_tool():
    """Demo 2: LLM tool with decorator."""
    print("\n" + "="*60)
    print("Demo 2: LLM Tool with Decorator")
    print("="*60)
    
    mcp_adapter, metering = setup_caracal_components()
    
    # Define an LLM tool
    @mcp_adapter.as_decorator()
    async def llm_completion(agent_id: str, prompt: str, model: str = "gpt-4", max_tokens: int = 1000):
        """Generate LLM completion."""
        print(f"  👾 Model: {model}")
        print(f"  📝 Prompt: '{prompt[:50]}...'")
        print(f"  🎯 Max tokens: {max_tokens}")
        
        # Simulate LLM call
        await asyncio.sleep(0.2)
        
        return {
            "completion": "This is a simulated LLM response...",
            "tokens_used": 850,
            "model": model
        }
    
    # Use the LLM tool
    agent_id = str(uuid4())
    print(f"\n👾 Agent: {agent_id[:8]}...")
    print("  ✅ Budget check passed")
    
    result = await llm_completion(
        agent_id=agent_id,
        prompt="Explain quantum computing in simple terms",
        model="gpt-4",
        max_tokens=500
    )
    
    print(f"  ✨ Completion generated: {len(result['completion'])} chars")
    print(f"  🎫 Tokens used: {result['tokens_used']}")
    print(f"  🪙 Total events metered: {len(metering.events)}")


async def demo_database_tool():
    """Demo 3: Database query tool with decorator."""
    print("\n" + "="*60)
    print("Demo 3: Database Query Tool with Decorator")
    print("="*60)
    
    mcp_adapter, metering = setup_caracal_components()
    
    # Define a database tool
    @mcp_adapter.as_decorator()
    async def query_database(agent_id: str, sql: str, database: str = "main"):
        """Execute a database query."""
        print(f"  🗄️  Database: {database}")
        print(f"  📜 Query: {sql[:60]}...")
        
        # Simulate database query
        await asyncio.sleep(0.15)
        
        return {
            "rows": [
                {"id": 1, "name": "Alice", "score": 95},
                {"id": 2, "name": "Bob", "score": 87},
                {"id": 3, "name": "Charlie", "score": 92},
            ],
            "count": 3,
            "execution_time_ms": 45
        }
    
    # Use the database tool
    agent_id = str(uuid4())
    print(f"\n👾 Agent: {agent_id[:8]}...")
    print("  ✅ Budget check passed")
    
    result = await query_database(
        agent_id=agent_id,
        sql="SELECT * FROM users WHERE score > 80 ORDER BY score DESC",
        database="analytics"
    )
    
    print(f"  📈 Rows returned: {result['count']}")
    print(f"  ⚡ Execution time: {result['execution_time_ms']}ms")
    print(f"  🪙 Total events metered: {len(metering.events)}")


async def demo_sync_function():
    """Demo 4: Synchronous function with decorator."""
    print("\n" + "="*60)
    print("Demo 4: Synchronous Function with Decorator")
    print("="*60)
    
    mcp_adapter, metering = setup_caracal_components()
    
    # Define a synchronous tool (decorator handles both sync and async)
    @mcp_adapter.as_decorator()
    def calculate_hash(agent_id: str, data: str):
        """Calculate hash of data."""
        import hashlib
        print(f"  🔐 Calculating hash for {len(data)} bytes")
        hash_value = hashlib.sha256(data.encode()).hexdigest()
        return {
            "hash": hash_value,
            "algorithm": "sha256",
            "input_size": len(data)
        }
    
    # Use the synchronous tool (note: we still await it)
    agent_id = str(uuid4())
    print(f"\n👾 Agent: {agent_id[:8]}...")
    print("  ✅ Budget check passed")
    
    result = await calculate_hash(
        agent_id=agent_id,
        data="Hello, Caracal!"
    )
    
    print(f"  🔑 Hash: {result['hash'][:16]}...")
    print(f"  📏 Input size: {result['input_size']} bytes")
    print(f"  🪙 Total events metered: {len(metering.events)}")


async def main():
    """Run all demos."""
    print("\n" + "="*60)
    print("MCP Adapter Decorator Demo")
    print("="*60)
    print("\nThis demo shows how to use the MCP adapter decorator")
    print("to automatically enforce budget checks and emit metering")
    print("events for MCP tool functions.")
    
    try:
        await demo_basic_decorator()
        await demo_llm_tool()
        await demo_database_tool()
        await demo_sync_function()
        
        print("\n" + "="*60)
        print("✅ All demos completed successfully!")
        print("="*60)
        print("\nKey Features Demonstrated:")
        print("  • Automatic budget checks before tool execution")
        print("  • Automatic metering events after tool execution")
        print("  • Support for both async and sync functions")
        print("  • Flexible agent_id parameter handling")
        print("  • Transparent error handling and logging")
        print()
        
    except Exception as e:
        print(f"\n❌ Demo failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
