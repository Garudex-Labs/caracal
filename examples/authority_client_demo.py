"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Demo script for AuthorityClient SDK.

This script demonstrates how to use the AuthorityClient SDK to interact
with the Caracal Authority Enforcement system.

Requirements:
- Caracal authority service running at http://localhost:8000
- Valid API key (if authentication is enabled)
"""

from caracal.sdk import AuthorityClient
from datetime import datetime, timedelta


def demo_synchronous_client():
    """Demonstrate synchronous AuthorityClient usage."""
    print("=== Synchronous AuthorityClient Demo ===\n")
    
    # Initialize client
    client = AuthorityClient(
        base_url="http://localhost:8000",
        api_key="your-api-key-here",  # Optional
        timeout=30
    )
    
    try:
        # 1. Request a mandate
        print("1. Requesting execution mandate...")
        mandate = client.request_mandate(
            issuer_id="admin-principal-id",
            subject_id="agent-principal-id",
            resource_scope=["api:openai:gpt-4", "database:users:read"],
            action_scope=["api_call", "database_query"],
            validity_seconds=3600,  # 1 hour
            metadata={"purpose": "data analysis task"}
        )
        print(f"   Mandate ID: {mandate['mandate_id']}")
        print(f"   Valid until: {mandate['valid_until']}\n")
        
        # 2. Validate the mandate
        print("2. Validating mandate...")
        decision = client.validate_mandate(
            mandate_id=mandate['mandate_id'],
            requested_action="api_call",
            requested_resource="api:openai:gpt-4"
        )
        print(f"   Allowed: {decision['allowed']}")
        if not decision['allowed']:
            print(f"   Denial reason: {decision.get('denial_reason')}\n")
        else:
            print()
        
        # 3. Delegate the mandate
        print("3. Delegating mandate to child agent...")
        child_mandate = client.delegate_mandate(
            parent_mandate_id=mandate['mandate_id'],
            child_subject_id="child-agent-principal-id",
            resource_scope=["api:openai:gpt-3.5"],  # Subset of parent
            action_scope=["api_call"],
            validity_seconds=1800  # 30 minutes
        )
        print(f"   Child mandate ID: {child_mandate['mandate_id']}")
        print(f"   Delegation depth: {child_mandate['delegation_depth']}\n")
        
        # 4. Query ledger events
        print("4. Querying authority ledger...")
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(hours=1)
        
        ledger_result = client.query_ledger(
            principal_id="agent-principal-id",
            start_time=start_time,
            end_time=end_time,
            limit=10
        )
        print(f"   Found {ledger_result['total_count']} events")
        for event in ledger_result['events'][:3]:
            print(f"   - {event['timestamp']}: {event['event_type']}")
        print()
        
        # 5. Revoke the mandate
        print("5. Revoking mandate...")
        revoke_result = client.revoke_mandate(
            mandate_id=mandate['mandate_id'],
            revoker_id="admin-principal-id",
            reason="Demo completed",
            cascade=True  # Revoke child mandates too
        )
        print(f"   Revoked {revoke_result['revoked_count']} mandate(s)\n")
        
    finally:
        # Clean up
        client.close()
        print("Client closed.")


def demo_context_manager():
    """Demonstrate AuthorityClient as context manager."""
    print("\n=== Context Manager Demo ===\n")
    
    # Use client as context manager (automatically closes)
    with AuthorityClient(base_url="http://localhost:8000") as client:
        print("Client initialized in context manager")
        
        # Request mandate
        mandate = client.request_mandate(
            issuer_id="admin-principal-id",
            subject_id="agent-principal-id",
            resource_scope=["api:openai:*"],
            action_scope=["api_call"],
            validity_seconds=3600
        )
        print(f"Mandate ID: {mandate['mandate_id']}")
    
    print("Client automatically closed on context exit\n")


async def demo_async_client():
    """Demonstrate AsyncAuthorityClient usage."""
    from caracal.sdk import AsyncAuthorityClient
    
    print("\n=== Async AuthorityClient Demo ===\n")
    
    # Use async client as context manager
    async with AsyncAuthorityClient(base_url="http://localhost:8000") as client:
        print("Async client initialized")
        
        # Request mandate asynchronously
        mandate = await client.request_mandate(
            issuer_id="admin-principal-id",
            subject_id="agent-principal-id",
            resource_scope=["api:openai:*"],
            action_scope=["api_call"],
            validity_seconds=3600
        )
        print(f"Mandate ID: {mandate['mandate_id']}")
        
        # Validate mandate asynchronously
        decision = await client.validate_mandate(
            mandate_id=mandate['mandate_id'],
            requested_action="api_call",
            requested_resource="api:openai:gpt-4"
        )
        print(f"Validation result: {decision['allowed']}")
    
    print("Async client automatically closed\n")


if __name__ == "__main__":
    print("Caracal Authority Client SDK Demo")
    print("=" * 50)
    print()
    print("NOTE: This demo requires a running Caracal authority service")
    print("      at http://localhost:8000")
    print()
    
    # Run synchronous demos
    try:
        demo_synchronous_client()
        demo_context_manager()
    except Exception as e:
        print(f"Error: {e}")
        print("\nMake sure the Caracal authority service is running!")
    
    # Run async demo (requires asyncio)
    print("\nTo run async demo, use:")
    print("  import asyncio")
    print("  asyncio.run(demo_async_client())")
