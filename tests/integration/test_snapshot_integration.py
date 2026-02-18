"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for snapshot functionality.

Tests the complete snapshot workflow including creation, listing, and recovery.
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from caracal.db.models import Base, LedgerSnapshot, LedgerEvent, MerkleRoot, AgentIdentity
from caracal.merkle.snapshot import SnapshotManager
from caracal.merkle.recovery import RecoveryManager


@pytest.fixture
def db_engine():
    """Create an in-memory SQLite database engine."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def db_session(db_engine):
    """Create a database session."""
    Session = sessionmaker(bind=db_engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def populated_ledger(db_session):
    """Create a populated ledger with agents and events."""
    # Create agents
    agents = []
    for i in range(3):
        agent = AgentIdentity(
            agent_id=uuid4(),
            name=f"test-agent-{i}",
            owner=f"test{i}@example.com",
        )
        db_session.add(agent)
        agents.append(agent)
    
    db_session.commit()
    
    # Create events for each agent
    events = []
    for agent in agents:
        for j in range(5):
            event = LedgerEvent(
                agent_id=agent.agent_id,
                timestamp=datetime.utcnow() - timedelta(hours=5-j),
                resource_type="test.resource",
                quantity=Decimal("1.0"),
                cost=Decimal(f"{(j+1)*10}.0"),
                currency="USD",
            )
            db_session.add(event)
            events.append(event)
    
    db_session.commit()
    
    # Create a Merkle root
    merkle_root = MerkleRoot(
        root_id=uuid4(),
        batch_id=uuid4(),
        merkle_root="a" * 64,
        signature="b" * 128,
        event_count=len(events),
        first_event_id=1,
        last_event_id=len(events),
    )
    db_session.add(merkle_root)
    db_session.commit()
    
    return {
        "agents": agents,
        "events": events,
        "merkle_root": merkle_root,
    }


class TestSnapshotIntegration:
    """Integration tests for snapshot functionality."""

    def test_complete_snapshot_workflow(self, db_session, populated_ledger):
        """Test complete snapshot workflow: create, list, load."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create snapshot
        snapshot = manager.create_snapshot()
        
        assert snapshot is not None
        assert snapshot.total_events == len(populated_ledger["events"])
        
        # List snapshots
        snapshots = manager.list_snapshots(limit=10)
        assert len(snapshots) == 1
        assert snapshots[0].snapshot_id == snapshot.snapshot_id
        
        # Load snapshot
        snapshot_data = manager.load_snapshot(snapshot.snapshot_id)
        assert snapshot_data is not None
        assert len(snapshot_data.agent_spending) == len(populated_ledger["agents"])

    def test_snapshot_aggregates_spending_correctly(self, db_session, populated_ledger):
        """Test that snapshot correctly aggregates spending per agent."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create snapshot
        snapshot = manager.create_snapshot()
        
        # Load snapshot data
        snapshot_data = manager.load_snapshot(snapshot.snapshot_id)
        
        # Verify spending aggregation
        # Each agent has 5 events with costs: 10, 20, 30, 40, 50 = 150 total
        expected_spending = Decimal("150.0")
        
        for agent in populated_ledger["agents"]:
            agent_spending = snapshot_data.agent_spending.get(agent.agent_id)
            assert agent_spending is not None
            assert agent_spending == expected_spending

    def test_recovery_workflow(self, db_session, populated_ledger):
        """Test complete recovery workflow."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        # Create snapshot
        snapshot = snapshot_manager.create_snapshot()
        
        # Add more events after snapshot
        new_events = []
        for agent in populated_ledger["agents"]:
            event = LedgerEvent(
                agent_id=agent.agent_id,
                timestamp=datetime.utcnow(),
                resource_type="test.resource",
                quantity=Decimal("1.0"),
                cost=Decimal("100.0"),
                currency="USD",
            )
            db_session.add(event)
            new_events.append(event)
        
        db_session.commit()
        
        # Recover from snapshot
        result = recovery_manager.recover_from_snapshot(snapshot.snapshot_id)
        
        assert result is not None
        assert result.snapshot_id == snapshot.snapshot_id
        assert result.agents_restored == len(populated_ledger["agents"])

    def test_multiple_snapshots_ordered_correctly(self, db_session, populated_ledger):
        """Test that multiple snapshots are ordered correctly."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create multiple snapshots
        snapshot1 = manager.create_snapshot()
        snapshot2 = manager.create_snapshot()
        snapshot3 = manager.create_snapshot()
        
        # List snapshots
        snapshots = manager.list_snapshots(limit=10)
        
        # Should be ordered newest first
        assert len(snapshots) == 3
        assert snapshots[0].snapshot_id == snapshot3.snapshot_id
        assert snapshots[1].snapshot_id == snapshot2.snapshot_id
        assert snapshots[2].snapshot_id == snapshot1.snapshot_id

    def test_snapshot_cleanup(self, db_session, populated_ledger):
        """Test snapshot cleanup with retention policy."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create old snapshot manually
        old_snapshot = LedgerSnapshot(
            snapshot_id=uuid4(),
            snapshot_timestamp=datetime.utcnow() - timedelta(days=100),
            total_events=0,
            merkle_root="",
            snapshot_data={"agent_spending": {}},
            created_at=datetime.utcnow() - timedelta(days=100),
        )
        db_session.add(old_snapshot)
        db_session.commit()
        
        # Create recent snapshot
        recent_snapshot = manager.create_snapshot()
        
        # Verify both exist
        all_snapshots = manager.list_snapshots(limit=10)
        assert len(all_snapshots) == 2
        
        # Cleanup with 90 day retention
        deleted_count = manager.cleanup_old_snapshots(retention_days=90)
        
        assert deleted_count == 1
        
        # Verify only recent snapshot remains
        remaining_snapshots = manager.list_snapshots(limit=10)
        assert len(remaining_snapshots) == 1
        assert remaining_snapshots[0].snapshot_id == recent_snapshot.snapshot_id

    def test_recovery_status(self, db_session, populated_ledger):
        """Test recovery status reporting."""
        snapshot_manager = SnapshotManager(db_session=db_session)
        recovery_manager = RecoveryManager(
            db_session=db_session,
            snapshot_manager=snapshot_manager,
        )
        
        # No snapshots initially
        status = recovery_manager.get_recovery_status()
        assert status["snapshot_available"] is False
        
        # Create snapshot
        snapshot = snapshot_manager.create_snapshot()
        
        # Get status
        status = recovery_manager.get_recovery_status()
        assert status["snapshot_available"] is True
        assert status["latest_snapshot_id"] == str(snapshot.snapshot_id)
        assert status["snapshot_events"] == len(populated_ledger["events"])
        assert status["events_after_snapshot"] == 0
        
        # Add events after snapshot
        for agent in populated_ledger["agents"]:
            event = LedgerEvent(
                agent_id=agent.agent_id,
                timestamp=datetime.utcnow(),
                resource_type="test.resource",
                quantity=Decimal("1.0"),
                cost=Decimal("50.0"),
                currency="USD",
            )
            db_session.add(event)
        
        db_session.commit()
        
        # Get updated status
        status = recovery_manager.get_recovery_status()
        assert status["events_after_snapshot"] == len(populated_ledger["agents"])

    def test_snapshot_with_empty_ledger(self, db_session):
        """Test creating snapshot with empty ledger."""
        manager = SnapshotManager(db_session=db_session)
        
        # Create snapshot with no events
        snapshot = manager.create_snapshot()
        
        assert snapshot is not None
        assert snapshot.total_events == 0
        assert snapshot.snapshot_data is not None
        
        # Load snapshot
        snapshot_data = manager.load_snapshot(snapshot.snapshot_id)
        assert len(snapshot_data.agent_spending) == 0

    def test_get_latest_snapshot(self, db_session, populated_ledger):
        """Test getting the latest snapshot."""
        manager = SnapshotManager(db_session=db_session)
        
        # No snapshots initially
        latest = manager.get_latest_snapshot()
        assert latest is None
        
        # Create snapshots
        snapshot1 = manager.create_snapshot()
        latest = manager.get_latest_snapshot()
        assert latest.snapshot_id == snapshot1.snapshot_id
        
        snapshot2 = manager.create_snapshot()
        latest = manager.get_latest_snapshot()
        assert latest.snapshot_id == snapshot2.snapshot_id
