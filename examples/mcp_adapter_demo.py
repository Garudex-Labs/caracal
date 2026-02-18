"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Demo script for MCP Adapter.

This script demonstrates how to use the MCP Adapter to intercept
MCP tool calls and resource reads with budget enforcement.
"""

import asyncio
import tempfile
import os
from decimal import Decimal
from pathlib import Path

from caracal.mcp import MCPAdapter, MCPContext, MCPCostCalculator
from caracal.core.policy import PolicyStore, PolicyEvaluator
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook
from caracal.core.ledger import LedgerWriter, LedgerQuery
from caracal.core.identity import AgentRegistry


async def main():
    """Run MCP adapter demo."""
    print("=" * 60)
    print("MCP Adapter Demo")
    print("=" * 60)
    print()
    
    # Create temporary directory for demo files
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Using temporary directory: {tmpdir}")
        print()
        
        # Initialize components
        print("Initializing Caracal Core components...")
        
        # Agent Registry
        agents_path = os.path.join(tmpdir, "agents.json")
        agent_registry = AgentRegistry(agents_path)
        
        # Pricebook
        pricebook_path = os.path.join(tmpdir, "pricebook.csv")
        pricebook = Pricebook(pricebook_path)
        
        # Add MCP prices
        pricebook.set_price("mcp.tool.default", Decimal("0.01"))
        pricebook.set_price("mcp.resource.default", Decimal("0.001"))
        pricebook.set_price("mcp.llm.gpt-4.input_tokens", Decimal("0.00003"))
        pricebook.set_price("mcp.llm.gpt-4.output_tokens", Decimal("0.00006"))
        pricebook.set_price("mcp.resource.file.per_mb", Decimal("0.0001"))
        
        # Ledger
        ledger_path = os.path.join(tmpdir, "ledger.jsonl")
        ledger_writer = LedgerWriter(ledger_path)
        ledger_query = LedgerQuery(ledger_path)
        
        # Policy Store
        policy_path = os.path.join(tmpdir, "policies.json")
        policy_store = PolicyStore(policy_path, agent_registry=agent_registry)
        
        # Metering Collector
        metering_collector = MeteringCollector(pricebook, ledger_writer)
        
        # Policy Evaluator
        policy_evaluator = PolicyEvaluator(policy_store, ledger_query)
        
        # Cost Calculator
        cost_calculator = MCPCostCalculator(pricebook)
        
        # MCP Adapter
        mcp_adapter = MCPAdapter(
            policy_evaluator=policy_evaluator,
            metering_collector=metering_collector,
            cost_calculator=cost_calculator
        )
        
        print("✓ Components initialized")
        print()
        
        # Register test agent
        print("Registering test agent...")
        agent = agent_registry.register_agent(
            name="demo-mcp-agent",
            owner="demo-user"
        )
        print(f"✓ Agent registered: {agent.name} ({agent.agent_id})")
        print()
        
        # Create budget policy
        print("Creating budget policy...")
        policy = policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("10.00"),
            time_window="daily"
        )
        print(f"✓ Policy created: ${policy.limit_amount} {policy.currency} per {policy.time_window}")
        print()
        
        # Create MCP context
        context = MCPContext(
            agent_id=agent.agent_id,
            metadata={"source": "demo", "environment": "test"}
        )
        
        # Demo 1: Simple tool call
        print("-" * 60)
        print("Demo 1: Simple Tool Call")
        print("-" * 60)
        
        tool_name = "calculator"
        tool_args = {"operation": "add", "a": 5, "b": 3}
        
        print(f"Calling tool: {tool_name}")
        print(f"Arguments: {tool_args}")
        print()
        
        result = await mcp_adapter.intercept_tool_call(tool_name, tool_args, context)
        
        if result.success:
            print("✓ Tool call succeeded")
            print(f"  Result: {result.result}")
            print(f"  Estimated cost: ${result.metadata['estimated_cost']} USD")
            print(f"  Actual cost: ${result.metadata['actual_cost']} USD")
            print(f"  Remaining budget: ${result.metadata['remaining_budget']} USD")
        else:
            print(f"✗ Tool call failed: {result.error}")
        print()
        
        # Demo 2: LLM tool call
        print("-" * 60)
        print("Demo 2: LLM Tool Call")
        print("-" * 60)
        
        tool_name = "llm_completion"
        tool_args = {
            "prompt": "What is the capital of France?",
            "max_tokens": 100,
            "model": "gpt-4"
        }
        
        print(f"Calling tool: {tool_name}")
        print(f"Prompt: {tool_args['prompt']}")
        print(f"Model: {tool_args['model']}")
        print()
        
        result = await mcp_adapter.intercept_tool_call(tool_name, tool_args, context)
        
        if result.success:
            print("✓ LLM tool call succeeded")
            print(f"  Result: {result.result}")
            print(f"  Estimated cost: ${result.metadata['estimated_cost']} USD")
            print(f"  Actual cost: ${result.metadata['actual_cost']} USD")
            print(f"  Remaining budget: ${result.metadata['remaining_budget']} USD")
        else:
            print(f"✗ LLM tool call failed: {result.error}")
        print()
        
        # Demo 3: Resource read
        print("-" * 60)
        print("Demo 3: Resource Read")
        print("-" * 60)
        
        resource_uri = "file:///data/document.txt"
        
        print(f"Reading resource: {resource_uri}")
        print()
        
        result = await mcp_adapter.intercept_resource_read(resource_uri, context)
        
        if result.success:
            print("✓ Resource read succeeded")
            print(f"  Resource: {result.result.uri}")
            print(f"  Size: {result.result.size} bytes")
            print(f"  MIME type: {result.result.mime_type}")
            print(f"  Estimated cost: ${result.metadata['estimated_cost']} USD")
            print(f"  Actual cost: ${result.metadata['actual_cost']} USD")
            print(f"  Remaining budget: ${result.metadata['remaining_budget']} USD")
        else:
            print(f"✗ Resource read failed: {result.error}")
        print()
        
        # Show ledger summary
        print("-" * 60)
        print("Ledger Summary")
        print("-" * 60)
        
        from datetime import datetime, timedelta
        events = ledger_query.get_events(
            agent_id=agent.agent_id,
            start_time=datetime.utcnow() - timedelta(minutes=1),
            end_time=datetime.utcnow() + timedelta(minutes=1)
        )
        
        print(f"Total events: {len(events)}")
        print()
        
        total_cost = Decimal("0")
        for i, event in enumerate(events, 1):
            print(f"Event {i}:")
            print(f"  Resource: {event.resource_type}")
            print(f"  Quantity: {event.quantity}")
            print(f"  Cost: ${event.cost} {event.currency}")
            print(f"  Timestamp: {event.timestamp}")
            total_cost += event.cost
            print()
        
        print(f"Total spending: ${total_cost} USD")
        print(f"Budget limit: ${policy.limit_amount} USD")
        print(f"Remaining: ${Decimal(policy.limit_amount) - total_cost} USD")
        print()
        
        print("=" * 60)
        print("Demo completed successfully!")
        print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
