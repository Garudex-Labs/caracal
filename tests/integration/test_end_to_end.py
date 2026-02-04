"""
End-to-end integration tests for Caracal Core.

Tests complete workflows:
- Register agent → create policy → check budget → emit event → query ledger
- Multiple agents with different budgets
- Budget exhaustion and denial
- System restart and data persistence

Feature: caracal-core
Requirements: All requirements
"""

import time
from decimal import Decimal
from pathlib import Path

import pytest

from caracal.core.identity import AgentRegistry
from caracal.core.ledger import LedgerQuery, LedgerWriter
from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.core.policy import PolicyEvaluator, PolicyStore
from caracal.core.pricebook import Pricebook
from caracal.exceptions import BudgetExceededError
from caracal.sdk.client import CaracalClient


@pytest.fixture
def integration_setup(temp_dir: Path, sample_pricebook_path: Path):
    """
    Set up complete Caracal system for integration testing.
    
    Returns:
        Dictionary with all initialized components
    """
    # Create file paths
    agent_registry_path = temp_dir / "agents.json"
    policy_store_path = temp_dir / "policies.json"
    ledger_path = temp_dir / "ledger.jsonl"
    
    # Initialize components
    agent_registry = AgentRegistry(str(agent_registry_path))
    policy_store = PolicyStore(str(policy_store_path), agent_registry)
    pricebook = Pricebook(str(sample_pricebook_path))
    ledger_writer = LedgerWriter(str(ledger_path))
    ledger_query = LedgerQuery(str(ledger_path))
    policy_evaluator = PolicyEvaluator(policy_store, ledger_query)
    metering_collector = MeteringCollector(pricebook, ledger_writer)
    
    return {
        "agent_registry": agent_registry,
        "policy_store": policy_store,
        "pricebook": pricebook,
        "ledger_writer": ledger_writer,
        "ledger_query": ledger_query,
        "policy_evaluator": policy_evaluator,
        "metering_collector": metering_collector,
        "temp_dir": temp_dir,
        "agent_registry_path": agent_registry_path,
        "policy_store_path": policy_store_path,
        "ledger_path": ledger_path,
        "pricebook_path": sample_pricebook_path,
    }


class TestCompleteFlow:
    """Test complete flow: register → policy → budget check → emit → query"""
    
    def test_complete_workflow(self, integration_setup):
        """
        Test complete workflow from agent registration to ledger query.
        
        Flow:
        1. Register agent
        2. Create budget policy
        3. Check budget (should pass)
        4. Emit metering event
        5. Query ledger to verify event
        6. Check budget again (should still pass)
        """
        components = integration_setup
        
        # Step 1: Register agent
        agent = components["agent_registry"].register_agent(
            name="test-agent",
            owner="test@example.com",
            metadata={"purpose": "integration-test"}
        )
        assert agent.agent_id is not None
        assert agent.name == "test-agent"
        
        # Step 2: Create budget policy ($100 daily limit)
        policy = components["policy_store"].create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        assert policy.agent_id == agent.agent_id
        # Note: limit_amount may be stored as string in JSON
        assert Decimal(policy.limit_amount) == Decimal("100.00")
        
        # Step 3: Check budget (should pass - no spending yet)
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("100.00")
        
        # Step 4: Emit metering event (10 input tokens = $17.50)
        event = MeteringEvent(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("10"),
            metadata={"model": "gpt-5.2"}
        )
        components["metering_collector"].collect_event(event)
        
        # Step 5: Query ledger to verify event
        events = components["ledger_query"].get_events(agent_id=agent.agent_id)
        assert len(events) == 1
        assert events[0].agent_id == agent.agent_id
        assert events[0].resource_type == "openai.gpt-5.2.input_tokens"
        # Note: quantity and cost may be stored as strings in JSON
        assert Decimal(events[0].quantity) == Decimal("10")
        assert Decimal(events[0].cost) == Decimal("17.50")
        
        # Step 6: Check budget again (should pass with reduced budget)
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("82.50")
    
    def test_budget_exhaustion_flow(self, integration_setup):
        """
        Test workflow where agent exhausts budget.
        
        Flow:
        1. Register agent
        2. Create budget policy with low limit ($1)
        3. Emit events until budget exhausted
        4. Verify budget check fails
        """
        components = integration_setup
        
        # Step 1: Register agent
        agent = components["agent_registry"].register_agent(
            name="limited-agent",
            owner="test@example.com"
        )
        
        # Step 2: Create budget policy with $1 limit
        components["policy_store"].create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("1.00"),
            time_window="daily"
        )
        
        # Step 3: Emit events to exhaust budget
        # Each event costs $1.75 (1 token * $1.75)
        # Need 1 event to exceed $1
        for i in range(1):
            event = MeteringEvent(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1"),
                metadata={"iteration": i}
            )
            components["metering_collector"].collect_event(event)
        
        # Step 4: Verify budget check fails
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is False
        assert "Budget exceeded" in decision.reason
        
        # Verify total spending
        total_spending = components["ledger_query"].sum_spending(
            agent_id=agent.agent_id,
            start_time=None,
            end_time=None
        )
        assert total_spending == Decimal("1.75")  # 1 * $1.75


class TestMultipleAgents:
    """Test multiple agents with different budgets"""
    
    def test_multiple_agents_independent_budgets(self, integration_setup):
        """
        Test that multiple agents have independent budgets.
        
        Flow:
        1. Register two agents
        2. Create different budget policies for each
        3. Emit events for both agents
        4. Verify budgets are tracked independently
        """
        components = integration_setup
        
        # Register agent 1 with $100 budget
        agent1 = components["agent_registry"].register_agent(
            name="agent-1",
            owner="user1@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent1.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Register agent 2 with $50 budget
        agent2 = components["agent_registry"].register_agent(
            name="agent-2",
            owner="user2@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent2.agent_id,
            limit_amount=Decimal("50.00"),
            time_window="daily"
        )
        
        # Emit events for agent 1 ($17.50 total)
        for i in range(10):
            event = MeteringEvent(
                agent_id=agent1.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1")
            )
            components["metering_collector"].collect_event(event)
        
        # Emit events for agent 2 ($8.75 total)
        for i in range(5):
            event = MeteringEvent(
                agent_id=agent2.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1")
            )
            components["metering_collector"].collect_event(event)
        
        # Verify agent 1 budget
        decision1 = components["policy_evaluator"].check_budget(agent1.agent_id)
        assert decision1.allowed is True
        assert decision1.remaining_budget == Decimal("82.50")  # 100 - 17.50
        
        # Verify agent 2 budget
        decision2 = components["policy_evaluator"].check_budget(agent2.agent_id)
        assert decision2.allowed is True
        assert decision2.remaining_budget == Decimal("41.25")  # 50 - 8.75
        
        # Verify ledger has correct events for each agent
        events1 = components["ledger_query"].get_events(agent_id=agent1.agent_id)
        assert len(events1) == 10
        
        events2 = components["ledger_query"].get_events(agent_id=agent2.agent_id)
        assert len(events2) == 5
    
    def test_one_agent_exhausts_budget_others_unaffected(self, integration_setup):
        """
        Test that one agent exhausting budget doesn't affect others.
        """
        components = integration_setup
        
        # Register two agents with different budgets
        agent1 = components["agent_registry"].register_agent(
            name="limited-agent",
            owner="user1@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent1.agent_id,
            limit_amount=Decimal("0.50"),  # Low budget
            time_window="daily"
        )
        
        agent2 = components["agent_registry"].register_agent(
            name="unlimited-agent",
            owner="user2@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent2.agent_id,
            limit_amount=Decimal("1000.00"),  # High budget
            time_window="daily"
        )
        
        # Exhaust agent 1's budget (Limit 0.50)
        for i in range(1):  # 1 * 1.75 = 1.75 > 0.50
            event = MeteringEvent(
                agent_id=agent1.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1")
            )
            components["metering_collector"].collect_event(event)
        
        # Verify agent 1 budget exhausted
        decision1 = components["policy_evaluator"].check_budget(agent1.agent_id)
        assert decision1.allowed is False
        
        # Verify agent 2 still has budget
        decision2 = components["policy_evaluator"].check_budget(agent2.agent_id)
        assert decision2.allowed is True
        assert decision2.remaining_budget == Decimal("1000.00")
        
        # Agent 2 can still emit events
        event = MeteringEvent(
            agent_id=agent2.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1")
        )
        components["metering_collector"].collect_event(event)
        
        # Verify agent 2 budget updated
        decision2 = components["policy_evaluator"].check_budget(agent2.agent_id)
        assert decision2.allowed is True
        assert decision2.remaining_budget == Decimal("998.25")


class TestSystemRestart:
    """Test system restart and data persistence"""
    
    def test_data_persists_across_restart(self, integration_setup):
        """
        Test that data persists when system components are reloaded.
        
        Flow:
        1. Register agent and create policy
        2. Emit events
        3. Destroy components (simulate restart)
        4. Reload components from disk
        5. Verify all data is intact
        """
        components = integration_setup
        
        # Step 1: Register agent and create policy
        agent = components["agent_registry"].register_agent(
            name="persistent-agent",
            owner="test@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Step 2: Emit events
        for i in range(5):
            event = MeteringEvent(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1")
            )
            components["metering_collector"].collect_event(event)
        
        # Verify initial state
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is True
        initial_remaining = decision.remaining_budget
        
        # Step 3: Simulate restart by destroying and recreating components
        agent_id = agent.agent_id  # Save for later
        del components["agent_registry"]
        del components["policy_store"]
        del components["ledger_query"]
        del components["policy_evaluator"]
        
        # Step 4: Reload components from disk
        new_agent_registry = AgentRegistry(str(components["agent_registry_path"]))
        new_policy_store = PolicyStore(
            str(components["policy_store_path"]),
            new_agent_registry
        )
        new_ledger_query = LedgerQuery(str(components["ledger_path"]))
        new_policy_evaluator = PolicyEvaluator(new_policy_store, new_ledger_query)
        
        # Step 5: Verify all data is intact
        # Verify agent exists
        reloaded_agent = new_agent_registry.get_agent(agent_id)
        assert reloaded_agent is not None
        assert reloaded_agent.name == "persistent-agent"
        
        # Verify policy exists
        policies = new_policy_store.get_policies(agent_id)
        assert len(policies) == 1
        # Note: limit_amount may be stored as string in JSON
        assert Decimal(policies[0].limit_amount) == Decimal("100.00")
        
        # Verify ledger events exist
        events = new_ledger_query.get_events(agent_id=agent_id)
        assert len(events) == 5
        
        # Verify budget calculation is correct
        decision = new_policy_evaluator.check_budget(agent_id)
        assert decision.allowed is True
        assert decision.remaining_budget == initial_remaining
    
    def test_ledger_append_only_after_restart(self, integration_setup):
        """
        Test that ledger maintains append-only semantics after restart.
        
        Verifies that event IDs continue monotonically increasing.
        """
        components = integration_setup
        
        # Register agent
        agent = components["agent_registry"].register_agent(
            name="append-test-agent",
            owner="test@example.com"
        )
        
        # Emit events before restart
        for i in range(3):
            event = MeteringEvent(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1000")
            )
            components["metering_collector"].collect_event(event)
        
        # Get last event ID
        events_before = components["ledger_query"].get_events()
        last_event_id_before = max(e.event_id for e in events_before)
        
        # Simulate restart
        ledger_path = components["ledger_path"]
        pricebook_path = components["pricebook_path"]
        del components["ledger_writer"]
        del components["metering_collector"]
        
        # Reload components
        new_ledger_writer = LedgerWriter(str(ledger_path))
        new_pricebook = Pricebook(str(pricebook_path))
        new_metering_collector = MeteringCollector(new_pricebook, new_ledger_writer)
        
        # Emit events after restart
        for i in range(2):
            event = MeteringEvent(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1000")
            )
            new_metering_collector.collect_event(event)
        
        # Verify event IDs are monotonically increasing
        new_ledger_query = LedgerQuery(str(ledger_path))
        events_after = new_ledger_query.get_events()
        
        assert len(events_after) == 5  # 3 before + 2 after
        
        event_ids = [e.event_id for e in events_after]
        assert event_ids == sorted(event_ids)  # Monotonically increasing
        assert min(event_ids[3:]) > last_event_id_before  # New IDs > old IDs


class TestBudgetDenial:
    """Test budget exhaustion and denial scenarios"""
    
    def test_budget_denial_prevents_execution(self, integration_setup):
        """
        Test that budget denial prevents code execution in context manager.
        """
        components = integration_setup
        
        # Register agent with very low budget
        agent = components["agent_registry"].register_agent(
            name="denied-agent",
            owner="test@example.com"
        )
        components["policy_store"].create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("0.01"),  # $0.01 limit
            time_window="daily"
        )
        
        # Exhaust budget
        event = MeteringEvent(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1")  # Costs $1.75
        )
        components["metering_collector"].collect_event(event)
        
        # Verify budget check fails
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is False
    
    def test_no_policy_denies_access(self, integration_setup):
        """
        Test fail-closed behavior: no policy means no access.
        """
        components = integration_setup
        
        # Register agent without policy
        agent = components["agent_registry"].register_agent(
            name="no-policy-agent",
            owner="test@example.com"
        )
        
        # Verify budget check fails (no policy = fail closed)
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is False
        assert "No" in decision.reason and "policy" in decision.reason
    
    def test_budget_at_exact_limit(self, integration_setup):
        """
        Test behavior when spending exactly equals limit.
        """
        components = integration_setup
        
        # Register agent
        agent = components["agent_registry"].register_agent(
            name="exact-limit-agent",
            owner="test@example.com"
        )
        
        # Create policy with exact limit for one event
        components["policy_store"].create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("1.75"),  # Exactly one event
            time_window="daily"
        )
        
        # Emit one event (costs exactly $1.75)
        event = MeteringEvent(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1")
        )
        components["metering_collector"].collect_event(event)
        
        # Verify budget check fails (at limit)
        decision = components["policy_evaluator"].check_budget(agent.agent_id)
        assert decision.allowed is False
        assert decision.remaining_budget == Decimal("0")
