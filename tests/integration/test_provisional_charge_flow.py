"""
Integration test for provisional charge flow.

This test demonstrates the complete flow:
1. PolicyEvaluator creates provisional charge during budget check
2. MeteringCollector releases provisional charge when final charge is created
"""

import asyncio
from datetime import datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ase.protocol import MeteringEvent
from caracal.core.identity import AgentRegistry
from caracal.core.ledger import LedgerQuery, LedgerWriter
from caracal.core.metering import MeteringCollector
from caracal.core.policy import PolicyEvaluator, PolicyStore
from caracal.core.pricebook import Pricebook
from caracal.core.provisional_charges import (
    ProvisionalChargeConfig,
    ProvisionalChargeManager,
)
from caracal.db.models import Base


@pytest.fixture
def db_session():
    """Create an in-memory SQLite database session for testing."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def temp_dir(tmp_path):
    """Create a temporary directory for test files."""
    return tmp_path


@pytest.fixture
def agent_registry(temp_dir):
    """Create an AgentRegistry for testing."""
    registry_path = temp_dir / "agents.json"
    return AgentRegistry(str(registry_path))


@pytest.fixture
def policy_store(temp_dir, agent_registry):
    """Create a PolicyStore for testing."""
    policy_path = temp_dir / "policies.json"
    return PolicyStore(str(policy_path), agent_registry)


@pytest.fixture
def ledger_writer(temp_dir):
    """Create a LedgerWriter for testing."""
    ledger_path = temp_dir / "ledger.jsonl"
    return LedgerWriter(str(ledger_path))


@pytest.fixture
def ledger_query(temp_dir):
    """Create a LedgerQuery for testing."""
    ledger_path = temp_dir / "ledger.jsonl"
    return LedgerQuery(str(ledger_path))


@pytest.fixture
def pricebook(temp_dir):
    """Create a Pricebook for testing."""
    pricebook_path = temp_dir / "pricebook.csv"
    pricebook_content = """resource_type,price_per_unit,currency,updated_at
api.call,0.01,USD,2024-01-15T10:00:00Z
"""
    pricebook_path.write_text(pricebook_content)
    return Pricebook(str(pricebook_path))


@pytest.fixture
def provisional_charge_manager(db_session):
    """Create a ProvisionalChargeManager for testing."""
    config = ProvisionalChargeConfig()
    return ProvisionalChargeManager(db_session, config)


@pytest.fixture
def policy_evaluator(policy_store, ledger_query, provisional_charge_manager):
    """Create a PolicyEvaluator with provisional charge support."""
    return PolicyEvaluator(policy_store, ledger_query, provisional_charge_manager)


@pytest.fixture
def metering_collector(pricebook, ledger_writer, provisional_charge_manager):
    """Create a MeteringCollector with provisional charge support."""
    return MeteringCollector(pricebook, ledger_writer, provisional_charge_manager)


class TestProvisionalChargeFlow:
    """Test the complete provisional charge flow."""

    def test_complete_flow(
        self,
        agent_registry,
        policy_store,
        policy_evaluator,
        metering_collector,
        provisional_charge_manager,
    ):
        """Test the complete flow from budget check to final charge."""
        # 1. Register an agent
        agent = agent_registry.register_agent("test-agent", "test-owner")
        agent_id = agent.agent_id
        
        # 2. Create a budget policy
        policy_store.create_policy(agent_id, Decimal("100.00"))
        
        # 3. Check budget with estimated cost (creates provisional charge)
        decision = policy_evaluator.check_budget(agent_id, estimated_cost=Decimal("10.00"))
        
        assert decision.allowed is True
        assert decision.provisional_charge_id is not None
        provisional_charge_id = decision.provisional_charge_id
        
        # 4. Verify provisional charge was created
        from uuid import UUID
        reserved = provisional_charge_manager.calculate_reserved_budget(UUID(agent_id))
        assert reserved == Decimal("10.00")
        
        # 5. Emit metering event (creates final charge and releases provisional)
        event = MeteringEvent(
            agent_id=agent_id,
            resource_type="api.call",
            quantity=Decimal("1000"),  # 1000 API calls
            timestamp=datetime.utcnow(),
            metadata={"operation": "test"}
        )
        metering_collector.collect_event(event, provisional_charge_id=provisional_charge_id)
        
        # 6. Verify provisional charge was released
        reserved_after = provisional_charge_manager.calculate_reserved_budget(UUID(agent_id))
        assert reserved_after == Decimal("0")
        
        # 7. Verify final charge was recorded in ledger
        decision_after = policy_evaluator.check_budget(agent_id)
        assert decision_after.allowed is True
        # Remaining budget should be 100 - 10 = 90 (1000 calls * 0.01 per call)
        assert decision_after.remaining_budget == Decimal("90.00")

    def test_budget_check_without_estimated_cost(
        self,
        agent_registry,
        policy_store,
        policy_evaluator,
    ):
        """Test budget check without estimated cost (no provisional charge)."""
        # 1. Register an agent
        agent = agent_registry.register_agent("test-agent", "test-owner")
        agent_id = agent.agent_id
        
        # 2. Create a budget policy
        policy_store.create_policy(agent_id, Decimal("100.00"))
        
        # 3. Check budget without estimated cost
        decision = policy_evaluator.check_budget(agent_id)
        
        assert decision.allowed is True
        assert decision.provisional_charge_id is None  # No provisional charge created

    def test_budget_exceeded_with_provisional_charges(
        self,
        agent_registry,
        policy_store,
        policy_evaluator,
        provisional_charge_manager,
    ):
        """Test that provisional charges are included in budget calculation."""
        # 1. Register an agent
        agent = agent_registry.register_agent("test-agent", "test-owner")
        agent_id = agent.agent_id
        
        # 2. Create a budget policy with small limit
        policy_store.create_policy(agent_id, Decimal("20.00"))
        
        # 3. Create first provisional charge
        decision1 = policy_evaluator.check_budget(agent_id, estimated_cost=Decimal("15.00"))
        assert decision1.allowed is True
        
        # 4. Try to create second provisional charge that would exceed budget
        decision2 = policy_evaluator.check_budget(agent_id, estimated_cost=Decimal("10.00"))
        assert decision2.allowed is False
        assert "Insufficient budget" in decision2.reason
