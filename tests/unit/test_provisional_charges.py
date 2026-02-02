"""
Unit tests for provisional charge management.
"""

from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from caracal.core.provisional_charges import (
    ProvisionalChargeConfig,
    ProvisionalChargeManager,
)
from caracal.db.models import Base, ProvisionalCharge
from caracal.exceptions import ProvisionalChargeError


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
def config():
    """Create a test configuration."""
    return ProvisionalChargeConfig(
        default_expiration_seconds=300,
        timeout_minutes=60,
        cleanup_interval_seconds=60,
        cleanup_batch_size=1000
    )


@pytest.fixture
def manager(db_session, config):
    """Create a ProvisionalChargeManager for testing."""
    return ProvisionalChargeManager(db_session, config)


class TestProvisionalChargeManager:
    """Test ProvisionalChargeManager class."""

    def test_create_provisional_charge(self, manager):
        """Test creating a provisional charge."""
        agent_id = uuid4()
        amount = Decimal("10.50")
        
        # Call synchronous method
        charge = manager.create_provisional_charge(agent_id, amount)
        
        assert charge.agent_id == agent_id
        assert charge.amount == amount
        assert charge.currency == "USD"
        assert charge.released is False
        assert charge.final_charge_event_id is None
        assert charge.expires_at > datetime.utcnow()

    def test_create_provisional_charge_with_custom_expiration(self, manager):
        """Test creating a provisional charge with custom expiration."""
        agent_id = uuid4()
        amount = Decimal("10.50")
        expiration_seconds = 600  # 10 minutes
        
        charge = manager.create_provisional_charge(agent_id, amount, expiration_seconds)
        
        # Check expiration is approximately correct (within 5 seconds)
        expected_expiration = datetime.utcnow() + timedelta(seconds=expiration_seconds)
        time_diff = abs((charge.expires_at - expected_expiration).total_seconds())
        assert time_diff < 5

    def test_create_provisional_charge_caps_expiration(self, manager):
        """Test that expiration is capped at maximum timeout."""
        agent_id = uuid4()
        amount = Decimal("10.50")
        expiration_seconds = 7200  # 2 hours (exceeds 60 minute max)
        
        charge = manager.create_provisional_charge(agent_id, amount, expiration_seconds)
        
        # Check expiration is capped at 60 minutes
        max_expiration = datetime.utcnow() + timedelta(minutes=60)
        time_diff = abs((charge.expires_at - max_expiration).total_seconds())
        assert time_diff < 5

    def test_release_provisional_charge(self, manager):
        """Test releasing a provisional charge."""
        agent_id = uuid4()
        amount = Decimal("10.50")
        
        # Create charge
        charge = manager.create_provisional_charge(agent_id, amount)
        
        # Release charge
        manager.release_provisional_charge(charge.charge_id, final_charge_event_id=123)
        
        # Verify charge is released
        manager.db_session.refresh(charge)
        assert charge.released is True
        assert charge.final_charge_event_id == 123

    def test_release_provisional_charge_idempotent(self, manager):
        """Test that releasing a charge multiple times is idempotent."""
        agent_id = uuid4()
        amount = Decimal("10.50")
        
        # Create charge
        charge = manager.create_provisional_charge(agent_id, amount)
        
        # Release charge twice
        manager.release_provisional_charge(charge.charge_id)
        manager.release_provisional_charge(charge.charge_id)
        
        # Verify charge is released
        manager.db_session.refresh(charge)
        assert charge.released is True

    def test_get_active_provisional_charges(self, manager):
        """Test getting active provisional charges."""
        agent_id = uuid4()
        
        # Create multiple charges
        charge1 = manager.create_provisional_charge(agent_id, Decimal("10.00"))
        charge2 = manager.create_provisional_charge(agent_id, Decimal("20.00"))
        
        # Create a released charge (should not be returned)
        charge3 = manager.create_provisional_charge(agent_id, Decimal("30.00"))
        manager.release_provisional_charge(charge3.charge_id)
        
        # Get active charges
        active_charges = manager.get_active_provisional_charges(agent_id)
        
        assert len(active_charges) == 2
        charge_ids = [c.charge_id for c in active_charges]
        assert charge1.charge_id in charge_ids
        assert charge2.charge_id in charge_ids
        assert charge3.charge_id not in charge_ids

    def test_calculate_reserved_budget(self, manager):
        """Test calculating reserved budget."""
        agent_id = uuid4()
        
        # Create multiple charges
        manager.create_provisional_charge(agent_id, Decimal("10.00"))
        manager.create_provisional_charge(agent_id, Decimal("20.00"))
        manager.create_provisional_charge(agent_id, Decimal("15.50"))
        
        # Calculate reserved budget
        reserved = manager.calculate_reserved_budget(agent_id)
        
        assert reserved == Decimal("45.50")

    def test_cleanup_expired_charges(self, manager, db_session):
        """Test cleaning up expired charges."""
        agent_id = uuid4()
        
        # Create an expired charge (manually set expires_at in the past)
        expired_charge = ProvisionalCharge(
            charge_id=uuid4(),
            agent_id=agent_id,
            amount=Decimal("10.00"),
            currency="USD",
            created_at=datetime.utcnow() - timedelta(minutes=10),
            expires_at=datetime.utcnow() - timedelta(minutes=5),
            released=False
        )
        db_session.add(expired_charge)
        db_session.commit()
        
        # Create a non-expired charge
        active_charge = manager.create_provisional_charge(agent_id, Decimal("20.00"))
        
        # Run cleanup
        released_count = manager.cleanup_expired_charges()
        
        assert released_count == 1
        
        # Verify expired charge is released
        db_session.refresh(expired_charge)
        assert expired_charge.released is True
        
        # Verify active charge is not released
        db_session.refresh(active_charge)
        assert active_charge.released is False

    def test_get_expired_charge_count(self, manager, db_session):
        """Test getting count of expired charges."""
        agent_id = uuid4()
        
        # Create expired charges
        for i in range(3):
            expired_charge = ProvisionalCharge(
                charge_id=uuid4(),
                agent_id=agent_id,
                amount=Decimal("10.00"),
                currency="USD",
                created_at=datetime.utcnow() - timedelta(minutes=10),
                expires_at=datetime.utcnow() - timedelta(minutes=5),
                released=False
            )
            db_session.add(expired_charge)
        db_session.commit()
        
        # Create active charge
        manager.create_provisional_charge(agent_id, Decimal("20.00"))
        
        # Get expired count
        count = manager.get_expired_charge_count(agent_id)
        
        assert count == 3
