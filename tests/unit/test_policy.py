"""
Unit tests for policy management.
"""

import json
import uuid
from decimal import Decimal
from pathlib import Path

import pytest

from caracal.core.identity import AgentRegistry
from caracal.core.policy import BudgetPolicy, PolicyStore
from caracal.exceptions import (
    AgentNotFoundError,
    InvalidPolicyError,
)


class TestBudgetPolicy:
    """Test BudgetPolicy dataclass."""

    def test_budget_policy_creation(self):
        """Test creating a BudgetPolicy."""
        policy = BudgetPolicy(
            policy_id="660e8400-e29b-41d4-a716-446655440001",
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount="100.00",
            time_window="daily",
            currency="USD",
            created_at="2024-01-15T10:05:00Z",
            active=True
        )
        
        assert policy.policy_id == "660e8400-e29b-41d4-a716-446655440001"
        assert policy.agent_id == "550e8400-e29b-41d4-a716-446655440000"
        assert policy.limit_amount == "100.00"
        assert policy.time_window == "daily"
        assert policy.currency == "USD"
        assert policy.active is True

    def test_budget_policy_to_dict(self):
        """Test converting BudgetPolicy to dictionary."""
        policy = BudgetPolicy(
            policy_id="660e8400-e29b-41d4-a716-446655440001",
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount="100.00",
            time_window="daily",
            currency="USD",
            created_at="2024-01-15T10:05:00Z",
            active=True
        )
        
        data = policy.to_dict()
        assert data["policy_id"] == "660e8400-e29b-41d4-a716-446655440001"
        assert data["agent_id"] == "550e8400-e29b-41d4-a716-446655440000"
        assert data["limit_amount"] == "100.00"

    def test_budget_policy_from_dict(self):
        """Test creating BudgetPolicy from dictionary."""
        data = {
            "policy_id": "660e8400-e29b-41d4-a716-446655440001",
            "agent_id": "550e8400-e29b-41d4-a716-446655440000",
            "limit_amount": "100.00",
            "time_window": "daily",
            "currency": "USD",
            "created_at": "2024-01-15T10:05:00Z",
            "active": True
        }
        
        policy = BudgetPolicy.from_dict(data)
        assert policy.policy_id == "660e8400-e29b-41d4-a716-446655440001"
        assert policy.agent_id == "550e8400-e29b-41d4-a716-446655440000"
        assert policy.limit_amount == "100.00"

    def test_get_limit_decimal(self):
        """Test converting limit amount to Decimal."""
        policy = BudgetPolicy(
            policy_id="660e8400-e29b-41d4-a716-446655440001",
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount="100.50",
            time_window="daily",
            currency="USD",
            created_at="2024-01-15T10:05:00Z",
            active=True
        )
        
        limit = policy.get_limit_decimal()
        assert isinstance(limit, Decimal)
        assert limit == Decimal("100.50")


class TestPolicyStore:
    """Test PolicyStore class."""

    def test_policy_store_initialization(self, temp_dir):
        """Test initializing a PolicyStore."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        assert store.policy_path == policy_path
        assert store.backup_count == 3
        assert len(store.list_all_policies()) == 0

    def test_create_policy(self, temp_dir):
        """Test creating a new policy."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        policy = store.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD"
        )
        
        # Verify policy properties
        assert policy.agent_id == "550e8400-e29b-41d4-a716-446655440000"
        assert policy.limit_amount == "100.00"
        assert policy.time_window == "daily"
        assert policy.currency == "USD"
        assert policy.active is True
        
        # Verify UUID v4 format
        try:
            uuid_obj = uuid.UUID(policy.policy_id, version=4)
            assert str(uuid_obj) == policy.policy_id
        except ValueError:
            pytest.fail("Policy ID is not a valid UUID v4")
        
        # Verify timestamp format
        assert policy.created_at.endswith("Z")
        assert "T" in policy.created_at

    def test_create_policy_with_agent_validation(self, temp_dir):
        """Test creating policy with agent existence validation."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        agent = registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Create policy for existing agent (should succeed)
        policy = store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00")
        )
        assert policy.agent_id == agent.agent_id

    def test_create_policy_nonexistent_agent(self, temp_dir):
        """Test creating policy for non-existent agent."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Attempt to create policy for non-existent agent
        with pytest.raises(AgentNotFoundError) as exc_info:
            store.create_policy(
                agent_id="non-existent-id",
                limit_amount=Decimal("100.00")
            )
        
        assert "non-existent-id" in str(exc_info.value)

    def test_create_policy_zero_limit(self, temp_dir):
        """Test that zero limit is rejected."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        with pytest.raises(InvalidPolicyError) as exc_info:
            store.create_policy(
                agent_id="550e8400-e29b-41d4-a716-446655440000",
                limit_amount=Decimal("0.00")
            )
        
        assert "positive" in str(exc_info.value).lower()

    def test_create_policy_negative_limit(self, temp_dir):
        """Test that negative limit is rejected."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        with pytest.raises(InvalidPolicyError) as exc_info:
            store.create_policy(
                agent_id="550e8400-e29b-41d4-a716-446655440000",
                limit_amount=Decimal("-50.00")
            )
        
        assert "positive" in str(exc_info.value).lower()

    def test_create_policy_invalid_time_window(self, temp_dir):
        """Test that non-daily time window is rejected in v0.1."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        with pytest.raises(InvalidPolicyError) as exc_info:
            store.create_policy(
                agent_id="550e8400-e29b-41d4-a716-446655440000",
                limit_amount=Decimal("100.00"),
                time_window="weekly"
            )
        
        assert "daily" in str(exc_info.value).lower()

    def test_get_policies(self, temp_dir):
        """Test retrieving policies for an agent."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        
        # Create policy
        policy = store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Retrieve policies
        policies = store.get_policies(agent_id)
        assert len(policies) == 1
        assert policies[0].policy_id == policy.policy_id
        assert policies[0].agent_id == agent_id

    def test_get_policies_no_policies(self, temp_dir):
        """Test retrieving policies for agent with no policies."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        policies = store.get_policies("non-existent-agent")
        assert len(policies) == 0

    def test_get_policies_multiple_agents(self, temp_dir):
        """Test that policies are isolated by agent."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        agent1_id = "550e8400-e29b-41d4-a716-446655440000"
        agent2_id = "660e8400-e29b-41d4-a716-446655440001"
        
        # Create policies for different agents
        policy1 = store.create_policy(
            agent_id=agent1_id,
            limit_amount=Decimal("100.00")
        )
        policy2 = store.create_policy(
            agent_id=agent2_id,
            limit_amount=Decimal("200.00")
        )
        
        # Verify isolation
        agent1_policies = store.get_policies(agent1_id)
        assert len(agent1_policies) == 1
        assert agent1_policies[0].policy_id == policy1.policy_id
        
        agent2_policies = store.get_policies(agent2_id)
        assert len(agent2_policies) == 1
        assert agent2_policies[0].policy_id == policy2.policy_id

    def test_list_all_policies(self, temp_dir):
        """Test listing all policies."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        # Create multiple policies
        policy1 = store.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("100.00")
        )
        policy2 = store.create_policy(
            agent_id="660e8400-e29b-41d4-a716-446655440001",
            limit_amount=Decimal("200.00")
        )
        
        # List all policies
        policies = store.list_all_policies()
        assert len(policies) == 2
        
        policy_ids = {p.policy_id for p in policies}
        assert policy1.policy_id in policy_ids
        assert policy2.policy_id in policy_ids

    def test_persistence(self, temp_dir):
        """Test that policies are persisted to disk."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        # Create policy
        policy = store.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD"
        )
        
        # Verify file was created
        assert policy_path.exists()
        
        # Verify file content
        with open(policy_path, 'r') as f:
            data = json.load(f)
        
        assert len(data) == 1
        assert data[0]["policy_id"] == policy.policy_id
        assert data[0]["agent_id"] == "550e8400-e29b-41d4-a716-446655440000"
        assert data[0]["limit_amount"] == "100.00"
        assert data[0]["time_window"] == "daily"
        assert data[0]["currency"] == "USD"
        assert data[0]["active"] is True

    def test_load_from_disk(self, temp_dir):
        """Test loading policies from disk."""
        policy_path = temp_dir / "policies.json"
        
        # Create first store and create policy
        store1 = PolicyStore(str(policy_path))
        policy = store1.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("100.00")
        )
        
        # Create second store (should load from disk)
        store2 = PolicyStore(str(policy_path))
        
        # Verify policy was loaded
        policies = store2.get_policies(policy.agent_id)
        assert len(policies) == 1
        assert policies[0].policy_id == policy.policy_id
        assert policies[0].agent_id == policy.agent_id
        assert policies[0].limit_amount == "100.00"

    def test_backup_creation(self, temp_dir):
        """Test that backups are created."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        # Create first policy (creates initial file)
        store.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("100.00")
        )
        
        # Create second policy (should create backup)
        store.create_policy(
            agent_id="660e8400-e29b-41d4-a716-446655440001",
            limit_amount=Decimal("200.00")
        )
        
        # Verify backup exists
        backup_path = Path(f"{policy_path}.bak.1")
        assert backup_path.exists()

    def test_decimal_precision(self, temp_dir):
        """Test that decimal precision is preserved."""
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path))
        
        # Create policy with precise decimal
        policy = store.create_policy(
            agent_id="550e8400-e29b-41d4-a716-446655440000",
            limit_amount=Decimal("123.456789")
        )
        
        # Verify precision is preserved
        assert policy.limit_amount == "123.456789"
        
        # Reload from disk
        store2 = PolicyStore(str(policy_path))
        policies = store2.get_policies(policy.agent_id)
        assert policies[0].limit_amount == "123.456789"
        
        # Verify Decimal conversion
        limit = policies[0].get_limit_decimal()
        assert limit == Decimal("123.456789")



class TestPolicyDecision:
    """Test PolicyDecision dataclass."""

    def test_policy_decision_allowed(self):
        """Test creating an allowed PolicyDecision."""
        from caracal.core.policy import PolicyDecision
        
        decision = PolicyDecision(
            allowed=True,
            reason="Within budget",
            remaining_budget=Decimal("50.00")
        )
        
        assert decision.allowed is True
        assert decision.reason == "Within budget"
        assert decision.remaining_budget == Decimal("50.00")

    def test_policy_decision_denied(self):
        """Test creating a denied PolicyDecision."""
        from caracal.core.policy import PolicyDecision
        
        decision = PolicyDecision(
            allowed=False,
            reason="Budget exceeded"
        )
        
        assert decision.allowed is False
        assert decision.reason == "Budget exceeded"
        assert decision.remaining_budget is None


class TestPolicyEvaluator:
    """Test PolicyEvaluator class."""

    def test_policy_evaluator_initialization(self, temp_dir):
        """Test initializing a PolicyEvaluator."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerQuery
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        policy_store = PolicyStore(str(policy_path))
        ledger_query = LedgerQuery(str(ledger_path))
        
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        
        assert evaluator.policy_store == policy_store
        assert evaluator.ledger_query == ledger_query

    def test_check_budget_no_policy(self, temp_dir):
        """Test budget check when no policy exists (fail-closed)."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerQuery
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        policy_store = PolicyStore(str(policy_path))
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        
        # Check budget for agent with no policy
        decision = evaluator.check_budget("non-existent-agent")
        
        assert decision.allowed is False
        assert "No active policy" in decision.reason
        assert decision.remaining_budget is None

    def test_check_budget_within_budget(self, temp_dir):
        """Test budget check when agent is within budget."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with some spending (less than limit)
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("30.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        assert decision.allowed is True
        assert "Within budget" in decision.reason
        assert decision.remaining_budget == Decimal("70.00")

    def test_check_budget_exceeded(self, temp_dir):
        """Test budget check when agent exceeds budget."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with spending exceeding limit
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("100"),
            cost=Decimal("120.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        assert decision.allowed is False
        assert "exceeded" in decision.reason.lower()
        assert "120.00" in decision.reason
        assert "100.00" in decision.reason
        assert decision.remaining_budget == Decimal("0")

    def test_check_budget_at_limit(self, temp_dir):
        """Test budget check when agent is exactly at limit."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with spending exactly at limit
        ledger_writer = LedgerWriter(str(ledger_path))
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("100"),
            cost=Decimal("100.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        # At limit should be denied (>= check)
        assert decision.allowed is False
        assert "exceeded" in decision.reason.lower()

    def test_check_budget_daily_window(self, temp_dir):
        """Test that budget check uses daily time window correctly."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime, timedelta
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with spending from yesterday (should not count)
        ledger_writer = LedgerWriter(str(ledger_path))
        yesterday = datetime.utcnow() - timedelta(days=1)
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("100"),
            cost=Decimal("150.00"),
            timestamp=yesterday
        )
        
        # Add spending from today
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("30.00"),
            timestamp=datetime.utcnow()
        )
        
        # Check budget (should only count today's spending)
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("70.00")

    def test_check_budget_multiple_events(self, temp_dir):
        """Test budget check with multiple events in the same day."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with multiple events
        ledger_writer = LedgerWriter(str(ledger_path))
        now = datetime.utcnow()
        
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource1",
            quantity=Decimal("10"),
            cost=Decimal("20.00"),
            timestamp=now
        )
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource2",
            quantity=Decimal("20"),
            cost=Decimal("30.00"),
            timestamp=now
        )
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource3",
            quantity=Decimal("30"),
            cost=Decimal("25.00"),
            timestamp=now
        )
        
        # Check budget (total: 75.00)
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("25.00")

    def test_check_budget_zero_spending(self, temp_dir):
        """Test budget check with no spending."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerQuery
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Check budget with no spending
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        decision = evaluator.check_budget(agent_id)
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("100.00")

    def test_check_budget_custom_time(self, temp_dir):
        """Test budget check with custom current_time parameter."""
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerWriter, LedgerQuery
        from datetime import datetime
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create ledger with spending at specific time
        ledger_writer = LedgerWriter(str(ledger_path))
        specific_time = datetime(2024, 1, 15, 14, 30, 0)
        ledger_writer.append_event(
            agent_id=agent_id,
            resource_type="test.resource",
            quantity=Decimal("10"),
            cost=Decimal("40.00"),
            timestamp=specific_time
        )
        
        # Check budget with custom time (same day)
        ledger_query = LedgerQuery(str(ledger_path))
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        check_time = datetime(2024, 1, 15, 18, 0, 0)
        decision = evaluator.check_budget(agent_id, current_time=check_time)
        
        assert decision.allowed is True
        assert decision.remaining_budget == Decimal("60.00")

    def test_check_budget_fail_closed_on_error(self, temp_dir):
        """Test that policy evaluator fails closed on critical errors."""
        from caracal.core.policy import PolicyEvaluator, PolicyEvaluationError
        from caracal.core.ledger import LedgerQuery
        from unittest.mock import Mock
        
        policy_path = temp_dir / "policies.json"
        ledger_path = temp_dir / "ledger.jsonl"
        
        # Create policy
        policy_store = PolicyStore(str(policy_path))
        agent_id = "550e8400-e29b-41d4-a716-446655440000"
        policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal("100.00")
        )
        
        # Create evaluator with mocked ledger query that raises an error
        ledger_query = Mock()
        ledger_query.sum_spending.side_effect = Exception("Simulated ledger error")
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        
        # Check budget should fail closed (raise exception)
        with pytest.raises(PolicyEvaluationError) as exc_info:
            evaluator.check_budget(agent_id)
        
        assert "Failed to query spending" in str(exc_info.value)


    def test_create_policy_with_delegation(self, temp_dir):
        """Test creating a delegated policy."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register parent and child agents
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        child = registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Create delegated policy
        policy = store.create_policy(
            agent_id=child.agent_id,
            limit_amount=Decimal("50.00"),
            delegated_from_agent_id=parent.agent_id
        )
        
        assert policy.agent_id == child.agent_id
        assert policy.delegated_from_agent_id == parent.agent_id
        assert policy.limit_amount == "50.00"

    def test_create_policy_delegation_nonexistent_parent(self, temp_dir):
        """Test that delegation from non-existent agent fails."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register child agent
        child = registry.register_agent(
            name="child-agent",
            owner="child@example.com"
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Attempt to create delegated policy with non-existent parent
        with pytest.raises(AgentNotFoundError) as exc_info:
            store.create_policy(
                agent_id=child.agent_id,
                limit_amount=Decimal("50.00"),
                delegated_from_agent_id="non-existent-id"
            )
        
        assert "non-existent-id" in str(exc_info.value)

    def test_create_policy_delegation_from_non_parent(self, temp_dir):
        """Test that delegation from non-parent agent fails."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agents
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        child = registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        unrelated = registry.register_agent(
            name="unrelated-agent",
            owner="unrelated@example.com"
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Attempt to create delegated policy from non-parent
        with pytest.raises(InvalidPolicyError) as exc_info:
            store.create_policy(
                agent_id=child.agent_id,
                limit_amount=Decimal("50.00"),
                delegated_from_agent_id=unrelated.agent_id
            )
        
        assert "not the parent" in str(exc_info.value)

    def test_get_delegated_policies(self, temp_dir):
        """Test retrieving delegated policies."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register parent and children
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        child1 = registry.register_agent(
            name="child-1",
            owner="child1@example.com",
            parent_agent_id=parent.agent_id
        )
        child2 = registry.register_agent(
            name="child-2",
            owner="child2@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Create delegated policies
        policy1 = store.create_policy(
            agent_id=child1.agent_id,
            limit_amount=Decimal("50.00"),
            delegated_from_agent_id=parent.agent_id
        )
        policy2 = store.create_policy(
            agent_id=child2.agent_id,
            limit_amount=Decimal("75.00"),
            delegated_from_agent_id=parent.agent_id
        )
        
        # Create non-delegated policy
        store.create_policy(
            agent_id=parent.agent_id,
            limit_amount=Decimal("200.00")
        )
        
        # Get delegated policies
        delegated = store.get_delegated_policies(parent.agent_id)
        
        assert len(delegated) == 2
        policy_ids = {p.policy_id for p in delegated}
        assert policy1.policy_id in policy_ids
        assert policy2.policy_id in policy_ids

    def test_get_delegated_policies_no_delegations(self, temp_dir):
        """Test getting delegated policies when none exist."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_agent(
            name="agent",
            owner="agent@example.com"
        )
        
        # Create policy store with registry
        policy_path = temp_dir / "policies.json"
        store = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Get delegated policies (should be empty)
        delegated = store.get_delegated_policies(agent.agent_id)
        assert len(delegated) == 0

    def test_delegation_persistence(self, temp_dir):
        """Test that delegation information is persisted."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register parent and child
        parent = registry.register_agent(
            name="parent-agent",
            owner="parent@example.com"
        )
        child = registry.register_agent(
            name="child-agent",
            owner="child@example.com",
            parent_agent_id=parent.agent_id
        )
        
        # Create first policy store and delegated policy
        policy_path = temp_dir / "policies.json"
        store1 = PolicyStore(str(policy_path), agent_registry=registry)
        policy = store1.create_policy(
            agent_id=child.agent_id,
            limit_amount=Decimal("50.00"),
            delegated_from_agent_id=parent.agent_id
        )
        
        # Create second policy store (should load from disk)
        store2 = PolicyStore(str(policy_path), agent_registry=registry)
        
        # Verify delegation was loaded
        loaded_policies = store2.get_policies(child.agent_id)
        assert len(loaded_policies) == 1
        assert loaded_policies[0].delegated_from_agent_id == parent.agent_id
        
        # Verify get_delegated_policies works after loading
        delegated = store2.get_delegated_policies(parent.agent_id)
        assert len(delegated) == 1
        assert delegated[0].policy_id == policy.policy_id
