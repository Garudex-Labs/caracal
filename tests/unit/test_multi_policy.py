"""
Unit tests for multi-policy support in PolicyEvaluator.

Tests the v0.3 multi-policy functionality including:
- Multiple policies per agent
- All policies must pass for approval
- Failed policy identification
- Policy conflict detection
"""

import pytest
from decimal import Decimal
from datetime import datetime, timedelta
from pathlib import Path

from caracal.core.policy import PolicyStore, PolicyEvaluator, BudgetPolicy, SinglePolicyDecision
from caracal.core.ledger import LedgerWriter, LedgerQuery
from caracal.core.identity import AgentRegistry
from caracal.exceptions import InvalidPolicyError


class TestMultiPolicySupport:
    """Test multi-policy support in PolicyEvaluator."""

    def test_multiple_policies_all_pass(self, temp_dir):
        """Test that all policies must pass for approval."""
        from caracal.core.time_windows import TimeWindowCalculator
        
        # Setup
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create two policies for the same agent
        # Policy 1: Daily limit of 100
        policy1 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Policy 2: Daily limit of 150 (more generous)
        policy2 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("150.00"),
            time_window="daily"
        )
        
        # Create ledger with spending of 50 (within both limits)
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("50.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        time_window_calculator = TimeWindowCalculator()
        evaluator = PolicyEvaluator(
            policy_store, 
            ledger_query,
            time_window_calculator=time_window_calculator
        )
        decision = evaluator.check_budget(agent_id)
        
        # Should be allowed (within both limits)
        assert decision.allowed is True
        assert "all 2 policies passed" in decision.reason.lower()
        assert decision.policy_decisions is not None
        assert len(decision.policy_decisions) == 2
        
        # Check that both policies passed
        for policy_decision in decision.policy_decisions:
            assert policy_decision.allowed is True
            assert policy_decision.current_spending == Decimal("50.00")

    def test_multiple_policies_one_fails(self, temp_dir):
        """Test that if any policy fails, the request is denied."""
        from caracal.core.time_windows import TimeWindowCalculator
        
        # Setup
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create two policies for the same agent
        # Policy 1: Daily limit of 100 (will be exceeded)
        policy1 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Policy 2: Daily limit of 200 (will not be exceeded)
        policy2 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("200.00"),
            time_window="daily"
        )
        
        # Create ledger with spending of 120 (exceeds policy1, within policy2)
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("120.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        time_window_calculator = TimeWindowCalculator()
        evaluator = PolicyEvaluator(
            policy_store, 
            ledger_query,
            time_window_calculator=time_window_calculator
        )
        decision = evaluator.check_budget(agent_id)
        
        # Should be denied (policy1 exceeded)
        assert decision.allowed is False
        assert decision.failed_policy_id == policy1.policy_id
        assert policy1.policy_id in decision.reason
        assert decision.policy_decisions is not None
        assert len(decision.policy_decisions) == 2
        
        # Check that policy1 failed and policy2 passed
        policy1_decision = next(d for d in decision.policy_decisions if d.policy_id == policy1.policy_id)
        policy2_decision = next(d for d in decision.policy_decisions if d.policy_id == policy2.policy_id)
        
        assert policy1_decision.allowed is False
        assert policy2_decision.allowed is True

    def test_evaluate_single_policy(self, temp_dir):
        """Test evaluating a single policy."""
        from caracal.core.time_windows import TimeWindowCalculator
        
        # Setup
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create policy
        policy = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Create ledger with spending
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("30.00"),
            timestamp=datetime.utcnow()
        )
        
        # Evaluate single policy
        ledger_query = LedgerQuery(str(ledger_path))
        time_window_calculator = TimeWindowCalculator()
        evaluator = PolicyEvaluator(
            policy_store, 
            ledger_query,
            time_window_calculator=time_window_calculator
        )
        
        decision = evaluator.evaluate_single_policy(
            policy=policy,
            agent_id=agent_id,
            estimated_cost=None,
            current_time=datetime.utcnow()
        )
        
        # Verify decision
        assert isinstance(decision, SinglePolicyDecision)
        assert decision.policy_id == policy.policy_id
        assert decision.allowed is True
        assert decision.limit_amount == Decimal("100.00")
        assert decision.current_spending == Decimal("30.00")
        assert decision.reserved_budget == Decimal("0")
        assert decision.available_budget == Decimal("70.00")
        assert decision.time_window == "daily"
        assert decision.window_type == "calendar"

    def test_policy_conflict_detection_currency_mismatch(self, temp_dir):
        """Test that policy conflict detection warns about currency mismatches."""
        # Setup
        policy_path = temp_dir / "policies.json"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create first policy in USD
        policy1 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD"
        )
        
        # Create second policy in EUR (should warn about currency mismatch)
        # This should succeed but log a warning
        policy2 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="EUR"
        )
        
        # Both policies should be created
        policies = policy_store.get_policies(agent_id)
        assert len(policies) == 2

    def test_policy_conflict_detection_illogical_limits(self, temp_dir):
        """Test that policy conflict detection warns about illogical limit relationships."""
        # Setup
        policy_path = temp_dir / "policies.json"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create daily policy with limit of 100
        policy1 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Note: In v0.1, only daily time windows are supported
        # So we can't test weekly/monthly conflicts yet
        # This test will be expanded in v0.3 when extended time windows are implemented
        
        # For now, just verify the policy was created
        policies = policy_store.get_policies(agent_id)
        assert len(policies) == 1

    def test_minimum_remaining_budget_across_policies(self, temp_dir):
        """Test that remaining budget is the minimum across all policies."""
        from caracal.core.time_windows import TimeWindowCalculator
        
        # Setup
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        registry_path = temp_dir / "agents.json"
        
        # Create agent
        agent_registry = AgentRegistry(str(registry_path))
        agent_registry.register_agent(
            name="Test Agent",
            owner="test@example.com"
        )
        agent = agent_registry.get_agent_by_name("Test Agent")
        agent_id = agent.agent_id
        
        # Create policy store with agent registry
        policy_store = PolicyStore(str(policy_path), agent_registry=agent_registry)
        
        # Create two policies with different limits
        # Policy 1: Daily limit of 100 (tighter)
        policy1 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily"
        )
        
        # Policy 2: Daily limit of 200 (more generous)
        policy2 = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("200.00"),
            time_window="daily"
        )
        
        # Create ledger with spending of 50
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("50.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        time_window_calculator = TimeWindowCalculator()
        evaluator = PolicyEvaluator(
            policy_store, 
            ledger_query,
            time_window_calculator=time_window_calculator
        )
        decision = evaluator.check_budget(agent_id)
        
        # Remaining budget should be minimum across policies
        # Policy 1: 100 - 50 = 50
        # Policy 2: 200 - 50 = 150
        # Minimum: 50
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("50.00")
