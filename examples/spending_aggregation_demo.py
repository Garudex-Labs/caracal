#!/usr/bin/env python3
"""
Demonstration of spending aggregation features in Caracal Core v0.2.

This script demonstrates:
1. Creating parent-child agent relationships
2. Recording spending for parent and child agents
3. Aggregating spending with sum_spending_with_children
4. Getting hierarchical spending breakdown
"""

import tempfile
from decimal import Decimal
from datetime import datetime, timedelta
from pathlib import Path

from caracal.core.identity import AgentRegistry
from caracal.core.ledger import LedgerWriter, LedgerQuery


def main():
    """Run spending aggregation demonstration."""
    
    # Create temporary directory for demo
    with tempfile.TemporaryDirectory() as tmpdir:
        temp_dir = Path(tmpdir)
        
        print("=" * 70)
        print("Caracal Core v0.2 - Spending Aggregation Demo")
        print("=" * 70)
        print()
        
        # Step 1: Create agent hierarchy
        print("Step 1: Creating agent hierarchy...")
        print("-" * 70)
        
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Create parent agent
        parent = registry.register_agent(
            name="parent-team",
            owner="manager@example.com",
            generate_keys=False
        )
        print(f"✓ Created parent agent: {parent.name} ({parent.agent_id})")
        
        # Create child agents
        child1 = registry.register_agent(
            name="child-agent-1",
            owner="dev1@example.com",
            parent_agent_id=parent.agent_id,
            generate_keys=False
        )
        print(f"✓ Created child agent 1: {child1.name} ({child1.agent_id})")
        
        child2 = registry.register_agent(
            name="child-agent-2",
            owner="dev2@example.com",
            parent_agent_id=parent.agent_id,
            generate_keys=False
        )
        print(f"✓ Created child agent 2: {child2.name} ({child2.agent_id})")
        
        # Create grandchild
        grandchild = registry.register_agent(
            name="grandchild-agent",
            owner="intern@example.com",
            parent_agent_id=child1.agent_id,
            generate_keys=False
        )
        print(f"✓ Created grandchild agent: {grandchild.name} ({grandchild.agent_id})")
        print()
        
        # Step 2: Record spending events
        print("Step 2: Recording spending events...")
        print("-" * 70)
        
        ledger_path = temp_dir / "ledger.jsonl"
        writer = LedgerWriter(str(ledger_path))
        base_time = datetime(2024, 1, 15, 10, 0, 0)
        
        # Parent spending
        writer.append_event(
            agent_id=parent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1"),
            cost=Decimal("1.75"),
            timestamp=base_time
        )
        print(f"✓ Parent spent: $1.75 (GPT-5.2 input tokens)")
        
        # Child 1 spending
        writer.append_event(
            agent_id=child1.agent_id,
            resource_type="openai.gpt-5.2.output_tokens",
            quantity=Decimal("1"),
            cost=Decimal("14.00"),
            timestamp=base_time
        )
        print(f"✓ Child 1 spent: $14.00 (GPT-5.2 output tokens)")
        
        # Child 2 spending
        writer.append_event(
            agent_id=child2.agent_id,
            resource_type="openai.gpt-5.2.cached_input_tokens",
            quantity=Decimal("10"),
            cost=Decimal("1.75"),
            timestamp=base_time
        )
        print(f"✓ Child 2 spent: $1.75 (GPT-5.2 cached input)")
        
        # Grandchild spending
        writer.append_event(
            agent_id=grandchild.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1"),
            cost=Decimal("1.75"),
            timestamp=base_time
        )
        print(f"✓ Grandchild spent: $1.75 (GPT-5.2 input tokens)")
        print()
        
        # Step 3: Query spending with aggregation
        print("Step 3: Querying spending with aggregation...")
        print("-" * 70)
        
        query = LedgerQuery(str(ledger_path))
        
        # Get spending for parent only
        parent_only = query.sum_spending(
            agent_id=parent.agent_id,
            start_time=base_time - timedelta(hours=1),
            end_time=base_time + timedelta(hours=1)
        )
        print(f"Parent's own spending: ${parent_only}")
        
        # Get spending with all children
        spending_with_children = query.sum_spending_with_children(
            agent_id=parent.agent_id,
            start_time=base_time - timedelta(hours=1),
            end_time=base_time + timedelta(hours=1),
            agent_registry=registry
        )
        
        print(f"\nSpending breakdown (parent + all descendants):")
        for agent_id, amount in spending_with_children.items():
            agent = registry.get_agent(agent_id)
            print(f"  {agent.name}: ${amount}")
        
        total = sum(spending_with_children.values())
        print(f"\nTotal spending (with children): ${total}")
        print()
        
        # Step 4: Get hierarchical breakdown
        print("Step 4: Getting hierarchical spending breakdown...")
        print("-" * 70)
        
        breakdown = query.get_spending_breakdown(
            agent_id=parent.agent_id,
            start_time=base_time - timedelta(hours=1),
            end_time=base_time + timedelta(hours=1),
            agent_registry=registry
        )
        
        def print_breakdown(data, indent=0):
            """Recursively print breakdown with indentation."""
            indent_str = "  " * indent
            agent_name = data.get("agent_name", data["agent_id"])
            
            if indent == 0:
                print(f"{indent_str}{agent_name}")
            else:
                print(f"{indent_str}└─ {agent_name}")
            
            print(f"{indent_str}   Own: ${data['spending']}")
            
            if data.get("children"):
                for child in data["children"]:
                    print_breakdown(child, indent + 1)
            
            if indent == 0:
                print(f"{indent_str}   Total (with children): ${data['total_with_children']}")
        
        print_breakdown(breakdown)
        print()
        
        # Step 5: Demonstrate CLI-style output
        print("Step 5: CLI-style hierarchical view...")
        print("-" * 70)
        print("This is what 'caracal ledger summary --breakdown' would show:")
        print()
        
        print(f"Agent: {parent.name} ({parent.agent_id})")
        print(f"   Own Spending: {breakdown['spending']} USD")
        
        for child_data in breakdown["children"]:
            child_name = child_data.get("agent_name", child_data["agent_id"])
            print(f"  └─ {child_name} ({child_data['agent_id']})")
            print(f"     Own Spending: {child_data['spending']} USD")
            
            for grandchild_data in child_data.get("children", []):
                grandchild_name = grandchild_data.get("agent_name", grandchild_data["agent_id"])
                print(f"    └─ {grandchild_name} ({grandchild_data['agent_id']})")
                print(f"       Own Spending: {grandchild_data['spending']} USD")
        
        print()
        print(f"Total (with children): {breakdown['total_with_children']} USD")
        print()
        
        print("=" * 70)
        print("✓ Demo completed successfully!")
        print("=" * 70)
        print()
        print("Key features demonstrated:")
        print("  • Parent-child agent relationships")
        print("  • Hierarchical spending aggregation")
        print("  • Multi-level descendant queries (grandchildren)")
        print("  • Structured breakdown for reporting")
        print()
        print("Try these CLI commands:")
        print("  caracal ledger summary --agent-id <id> --aggregate-children \\")
        print("    --start 2024-01-01 --end 2024-01-31")
        print()
        print("  caracal ledger summary --agent-id <id> --breakdown \\")
        print("    --start 2024-01-01 --end 2024-01-31")
        print()
        print("  caracal ledger delegation-chain --agent-id <id>")


if __name__ == "__main__":
    main()
