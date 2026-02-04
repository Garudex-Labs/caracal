"""
Integration tests for Caracal Core v0.3 API functionality.

This module tests that all v0.3 API calls work correctly,
including all features from the system.

Requirements: 22.1
"""

import pytest
from decimal import Decimal
from uuid import uuid4

from caracal.core.identity import AgentRegistry
from caracal.core.policy import PolicyStore, PolicyEvaluator
from caracal.core.ledger import LedgerWriter, LedgerQuery
from caracal.core.delegation import DelegationTokenManager
from caracal.core.provisional_charges import ProvisionalChargeManager
from caracal.db.connection import get_session
from caracal.config.settings import load_config


class TestAPIFunctionality:
    """
    Test v0.3 API functionality.
    
    These tests verify that all v0.3 API calls work correctly,
    including features that were present in earlier versions.
    """
    
    @pytest.fixture
    def config(self):
        """Load test configuration."""
        return load_config()
    
    @pytest.fixture
    def db_session(self, config):
        """Create database session."""
        with get_session(config.database) as session:
            yield session
    
    @pytest.fixture
    def agent_registry(self, db_session):
        """Create agent registry."""
        return AgentRegistry(db_session)
    
    @pytest.fixture
    def policy_store(self, db_session):
        """Create policy store."""
        return PolicyStore(db_session)
    
    @pytest.fixture
    def ledger_writer(self, db_session):
        """Create ledger writer."""
        return LedgerWriter(db_session)
    
    @pytest.fixture
    def ledger_query(self, db_session):
        """Create ledger query."""
        return LedgerQuery(db_session)
    
    def test_agent_registration_api(self, agent_registry):
        """
        Test that agent registration API works correctly.
        
        Requirements: 22.1
        """
        # API: register agent with name and owner
        agent_name = f"test-agent-{uuid4()}"
        agent = agent_registry.register_agent(
            name=agent_name,
            owner="test-owner"
        )
        
        assert agent.name == agent_name
        assert agent.owner == "test-owner"
        assert agent.agent_id is not None
        
        # API: get agent by name
        retrieved = agent_registry.get_agent_by_name(agent_name)
        assert retrieved.agent_id == agent.agent_id
    
    def test_policy_creation_api(self, agent_registry, policy_store):
        """
        Test that policy creation API works correctly.
        
        Requirements: 22.1
        """
        # Create agent
        agent = agent_registry.register_agent(
            name=f"test-agent-{uuid4()}",
            owner="test-owner"
        )
        
        # API: create policy with limit_amount, time_window, currency
        policy = policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD"
        )
        
        assert policy.agent_id == agent.agent_id
        assert policy.limit_amount == Decimal("100.00")
        assert policy.time_window == "daily"
        assert policy.currency == "USD"
        assert policy.active is True
        
        # v0.3 adds window_type, defaults to "calendar"
        assert policy.window_type == "calendar"
    
    def test_ledger_write_api(self, agent_registry, ledger_writer):
        """
        Test that ledger write API works correctly.
        
        Requirements: 22.1
        """
        # Create agent
        agent = agent_registry.register_agent(
            name=f"test-agent-{uuid4()}",
            owner="test-owner"
        )
        
        # API: write ledger event
        event = ledger_writer.write_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.input_tokens",
            quantity=Decimal("1"),
            cost=Decimal("1.75"),
            currency="USD"
        )
        
        assert event.agent_id == agent.agent_id
        assert event.resource_type == "openai.gpt-5.2.input_tokens"
        assert event.quantity == Decimal("1")
        assert event.cost == Decimal("1.75")
        assert event.currency == "USD"
        
        # merkle_root_id is None for events not yet batched
        assert event.merkle_root_id is None
    
    def test_ledger_query_api(self, agent_registry, ledger_writer, ledger_query):
        """
        Test that ledger query API works correctly.
        
        Requirements: 22.1
        """
        # Create agent
        agent = agent_registry.register_agent(
            name=f"test-agent-{uuid4()}",
            owner="test-owner"
        )
        
        # Write some events
        for i in range(5):
            ledger_writer.write_event(
                agent_id=agent.agent_id,
                resource_type="openai.gpt-5.2.input_tokens",
                quantity=Decimal("1"),
                cost=Decimal("1.75"),
                currency="USD"
            )
        
        # v0.2 API: query spending
        from datetime import datetime, timedelta
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(days=1)
        
        spending = ledger_query.get_spending(
            agent_id=agent.agent_id,
            start_time=start_time,
            end_time=end_time
        )
        
        assert spending == Decimal("8.75")  # 5 events * 1.75
    
    def test_delegation_api(self, agent_registry, policy_store):
        """
        Test that delegation API works correctly.
        
        Requirements: 22.1
        """
        # Create parent agent
        parent = agent_registry.register_agent(
            name=f"parent-{uuid4()}",
            owner="test-owner"
        )
        
        # Create parent policy
        parent_policy = policy_store.create_policy(
            agent_id=parent.agent_id,
            limit_amount=Decimal("1000.00"),
            time_window="daily",
            currency="USD"
        )
        
        # API: create child agent with delegation
        child = agent_registry.register_agent(
            name=f"child-{uuid4()}",
            owner="test-owner",
            parent_agent_id=parent.agent_id
        )
        
        # API: create delegated policy
        child_policy = policy_store.create_policy(
            agent_id=child.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD",
            delegated_from_agent_id=parent.agent_id
        )
        
        assert child.parent_agent_id == parent.agent_id
        assert child_policy.delegated_from_agent_id == parent.agent_id
    
    def test_provisional_charges_api(self, agent_registry, db_session):
        """
        Test that provisional charges API works correctly.
        
        Requirements: 22.1
        """
        # Create agent
        agent = agent_registry.register_agent(
            name=f"test-agent-{uuid4()}",
            owner="test-owner"
        )
        
        # API: create provisional charge
        pc_manager = ProvisionalChargeManager(db_session)
        
        charge = pc_manager.create_charge(
            agent_id=agent.agent_id,
            amount=Decimal("14.00"),
            currency="USD",
            resource_type="openai.gpt-5.2.output_tokens"
        )
        
        assert charge.agent_id == agent.agent_id
        assert charge.amount == Decimal("14.00")
        assert charge.currency == "USD"
        assert charge.released is False
        
        # API: release provisional charge
        pc_manager.release_charge(charge.charge_id)
        
        # Verify charge is released
        db_session.refresh(charge)
        assert charge.released is True
    
    def test_policy_evaluator_api(self, agent_registry, policy_store, ledger_writer, db_session):
        """
        Test that policy evaluator API works correctly.
        
        Requirements: 22.1
        """
        # Create agent
        agent = agent_registry.register_agent(
            name=f"test-agent-{uuid4()}",
            owner="test-owner"
        )
        
        # Create policy
        policy = policy_store.create_policy(
            agent_id=agent.agent_id,
            limit_amount=Decimal("100.00"),
            time_window="daily",
            currency="USD"
        )
        
        # Write some spending
        ledger_writer.write_event(
            agent_id=agent.agent_id,
            resource_type="openai.gpt-5.2.output_tokens",
            quantity=Decimal("1"),
            cost=Decimal("14.00"),
            currency="USD"
        )
        
        # API: evaluate policy
        evaluator = PolicyEvaluator(db_session)
        
        # Should allow (14 + 1.75 = 15.75 < 100)
        result = evaluator.evaluate(
            agent_id=agent.agent_id,
            estimated_cost=Decimal("1.75"),
            currency="USD"
        )
        
        assert result.allowed is True
        
        # Should deny (14 + 90 = 104 > 100)
        result = evaluator.evaluate(
            agent_id=agent.agent_id,
            estimated_cost=Decimal("90.00"),
            currency="USD"
        )
        
        assert result.allowed is False
        assert "budget" in result.reason.lower()
