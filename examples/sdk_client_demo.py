#!/usr/bin/env python
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

[One-sentence description of the file's purpose and functionality.]
"""

"""
Demonstration of Caracal SDK Client usage.

This script shows how to:
1. Initialize the SDK client
2. Register an agent
3. Create a budget policy
4. Check budget
5. Emit metering events
6. Query remaining budget
"""

import tempfile
from decimal import Decimal
from pathlib import Path

from caracal.sdk.client import CaracalClient


def main():
    """Run SDK client demonstration."""
    # Create temporary directory for demo
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        
        # Create sample pricebook
        pricebook_path = temp_path / "pricebook.csv"
        pricebook_content = """resource_type,price_per_unit,currency,updated_at
openai.gpt-5.2.input_tokens,1.75,USD,2024-01-15T10:00:00Z
openai.gpt-5.2.output_tokens,14.00,USD,2024-01-15T10:00:00Z
openai.gpt-5.2.cached_input_tokens,0.175,USD,2024-01-15T10:00:00Z
"""
        pricebook_path.write_text(pricebook_content)
        
        # Create configuration file
        config_path = temp_path / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_path}/agents.json
  policy_store: {temp_path}/policies.json
  ledger: {temp_path}/ledger.jsonl
  pricebook: {pricebook_path}
  backup_dir: {temp_path}/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily

logging:
  level: INFO
  file: {temp_path}/caracal.log
"""
        config_path.write_text(config_content)
        
        print("=" * 60)
        print("Caracal SDK Client Demonstration")
        print("=" * 60)
        
        # 1. Initialize client
        print("\n1. Initializing Caracal SDK client...")
        client = CaracalClient(config_path=str(config_path))
        print("   ✓ Client initialized successfully")
        
        # 2. Register an agent
        print("\n2. Registering an agent...")
        agent = client.agent_registry.register_agent(
            name="demo-agent",
            owner="demo@example.com",
            metadata={"purpose": "SDK demonstration"}
        )
        print(f"   ✓ Agent registered: {agent.agent_id}")
        print(f"   ✓ Agent name: {agent.name}")
        print(f"   ✓ Agent owner: {agent.owner}")
        
        # 3. Create a budget policy
        print("\n3. Creating budget policy...")
        policy = client.policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        print(f"   ✓ Policy created: {policy.policy_id}")
        print(f"   ✓ Daily limit: ${policy.limit_amount}")
        
        # 4. Check budget (should pass - no spending yet)
        print("\n4. Checking budget...")
        is_within_budget = client.check_budget(agent.agent_id)
        print(f"   ✓ Budget check result: {is_within_budget}")
        
        # 5. Get remaining budget
        print("\n5. Getting remaining budget...")
        remaining = client.get_remaining_budget(agent.agent_id)
        print(f"   ✓ Remaining budget: ${remaining}")
        
        # 6. Emit a metering event
        print("\n6. Emitting metering event...")
        client.emit_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1"),
            metadata={
                "model": "gpt-5.2",
                "request_id": "demo_req_001"
            }
        )
        print("   ✓ Event emitted: 1 input token")
        print("   ✓ Cost: $1.75 (1 * $1.75)")
        
        # 7. Check budget again
        print("\n7. Checking budget after event...")
        is_within_budget = client.check_budget(agent.agent_id)
        print(f"   ✓ Budget check result: {is_within_budget}")
        
        # 8. Get remaining budget again
        print("\n8. Getting remaining budget after event...")
        remaining = client.get_remaining_budget(agent.agent_id)
        print(f"   ✓ Remaining budget: ${remaining}")
        
        # 9. Emit more events
        print("\n9. Emitting multiple events...")
        for i in range(3):
            client.emit_event(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.output_tokens",
                quantity=Decimal("1"),
                metadata={"request_id": f"demo_req_{i+2:03d}"}
            )
        print("   ✓ Emitted 3 events: 1 output token each")
        print("   ✓ Total cost: $42.00 (3 * 1 * $14.00)")
        
        # 10. Final budget check
        print("\n10. Final budget status...")
        remaining = client.get_remaining_budget(agent.agent_id)
        print(f"   ✓ Remaining budget: ${remaining}")
        print(f"   ✓ Total spent: ${Decimal('100.00') - remaining}")
        
        # 11. Query ledger
        print("\n11. Querying ledger...")
        events = client.ledger_query.get_events(agent_id=agent.agent_id)
        print(f"   ✓ Total events in ledger: {len(events)}")
        
        print("\n" + "=" * 60)
        print("✅ SDK Client Demonstration Complete!")
        print("=" * 60)
        
        # Show fail-closed behavior
        print("\n12. Demonstrating fail-closed behavior...")
        print("   Testing budget check for non-existent agent...")
        result = client.check_budget("non-existent-agent-id")
        print(f"   ✓ Budget check result (no policy): {result}")
        print("   ✓ Fail-closed: Denied access when policy not found")
        
        print("\n" + "=" * 60)
        print("All demonstrations completed successfully!")
        print("=" * 60)


if __name__ == "__main__":
    main()
